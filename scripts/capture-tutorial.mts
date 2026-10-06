import { createServer } from 'node:net';
import { build } from '../server/app.ts';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

async function main() {
  process.umask(0o077);
  const require = createRequire(import.meta.url);
  const { chromium } = require(
    process.env.PLAYWRIGHT_MODULE || 'playwright-core',
  );
  const { PNG } = require('pngjs');
  if (!process.env.TUTORIAL_OUTPUT_DIR)
    throw new Error('Set TUTORIAL_OUTPUT_DIR to a new evidence directory');
  const out = resolve(process.env.TUTORIAL_OUTPUT_DIR);
  await mkdir(out, { recursive: true });
  const temp = await mkdtemp(resolve(tmpdir(), 'jlucraft-e2e-skin-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    `${temp}/key.pem`,
    key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://localhost:${port}`;
  let code = '';
  const app = await build(
    {
      listen: '127.0.0.1',
      port: 0,
      origin,
      database: `${temp}/db`,
      textures: `${temp}/textures`,
      signingKey: `${temp}/key.pem`,
      schools: { jlu: { emailDomains: ['school.test'] } },
      peers: [],
      smtp: { host: 'unused', port: 465, from: 'test@school.test' },
      webRoot: fileURLToPath(new URL('../dist', import.meta.url)),
    },
    {
      mail: async (_email, value) => {
        code = value;
      },
    },
  );
  let browser;
  const shots: object[] = [];
  try {
    await app.listen({ host: '127.0.0.1', port });
    const address = origin;
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      headless: true,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name: string, step: string) => {
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
      shots.push({
        file: `${name}.png`,
        step,
        scope:
          '真实浏览器 → HTTP → SQLite；邮件使用本地测试收件器，未验证 SMTP/MUA/联邦身份',
      });
      await writeFile(
        `${out}/skin-manifest.json`,
        JSON.stringify(shots, null, 2),
      );
    };
    const visible = async (text: string) =>
      page.getByText(text, { exact: true }).waitFor();
    await page.goto(`${address}/portal/`);
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    await shot('skin-01-login', '打开皮肤站登录页');
    await page.getByRole('tab', { name: '注册新账号' }).click();
    await page
      .getByLabel('学校邮箱', { exact: true })
      .fill('tutorial@school.test');
    await page.getByLabel('游戏名称').fill('CampusGuide');
    await page.getByLabel('设置密码').fill('Tutorial-Only-2026');
    await shot('skin-02-register', '选择学校，填写测试邮箱、游戏名称与密码');
    await page.getByRole('button', { name: '发送验证邮件' }).click();
    await visible('验证邮件已发送，15 分钟内有效');
    await shot(
      'skin-03-verification',
      '提交注册后显示验证码输入框；验证码由本地收件器接收',
    );
    await page.getByLabel('邮件验证码').fill(code);
    await page.getByLabel('设置密码').fill('Tutorial-Revised-2026');
    await page
      .getByRole('button', { name: '确认邮箱' })
      .waitFor({ state: 'detached' });
    await page.getByRole('status').waitFor({ state: 'detached' });
    await shot(
      'skin-03a-edit-registration',
      '修改注册密码后，旧验证码输入步骤退出，需要重新发送验证邮件',
    );
    await page.getByRole('button', { name: '发送验证邮件' }).click();
    await visible('验证邮件已发送，15 分钟内有效');
    assert.equal(await page.getByLabel('邮件验证码').inputValue(), '');
    await shot('skin-03b-resend', '重新发送后，使用对应新注册信息的验证码');
    assert.ok(code);
    await page.getByLabel('邮件验证码').fill(code);
    await page.getByRole('button', { name: '确认邮箱' }).click();
    await visible('邮箱验证完成，请使用邮箱和密码登录');
    await shot('skin-04-verified', '完成邮箱验证');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await visible('登录成功');
    await page.getByLabel('上传皮肤').waitFor({ state: 'attached' });
    await shot('skin-05-profile', '登录成功，查看尚未设置材质的角色');
    for (const [kind, label, width, height] of [
      ['skin', '上传皮肤', 64, 64],
      ['cape', '上传披风', 64, 32],
    ] as const) {
      const png = new PNG({ width, height });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 40;
        png.data[i + 1] = 130;
        png.data[i + 2] = 180;
        png.data[i + 3] = 255;
      }
      await page.getByLabel(label).setInputFiles({
        name: `tutorial-${kind}.png`,
        mimeType: 'image/png',
        buffer: PNG.sync.write(png),
      });
      await page
        .getByAltText(kind === 'skin' ? '当前皮肤材质' : '当前披风材质')
        .waitFor();
      await shot(
        `skin-06-${kind}`,
        `上传测试${kind === 'skin' ? '皮肤' : '披风'}并确认服务端返回材质预览`,
      );
    }
    await page.getByRole('button', { name: '衣柜', exact: true }).click();
    await page.getByText('管理材质', { exact: true }).first().waitFor();
    await shot('skin-12-wardrobe', '上传的皮肤和披风自动保存在衣柜');
    await page.getByText('管理材质', { exact: true }).first().click();
    await page.getByLabel('名称', { exact: true }).first().fill('校园披风');
    await page.getByLabel('公开到皮肤库').first().check();
    await page
      .getByRole('button', { name: '保存', exact: true })
      .first()
      .click();
    await visible('操作已完成');
    await shot('skin-13-publish', '为材质命名并公开到本站皮肤库');
    await page.getByRole('button', { name: '皮肤库', exact: true }).click();
    await page
      .getByRole('heading', { name: '校园披风', exact: true })
      .waitFor();
    await shot('skin-14-library', '公开材质进入皮肤库，可以下载或收藏');
    await page.getByRole('button', { name: '收藏到衣柜', exact: true }).click();
    await visible('操作已完成');
    await shot('skin-15-collected', '收藏成功，同一材质不会在衣柜中重复出现');
    await page.getByRole('button', { name: '角色外观', exact: true }).click();
    await page.getByAltText('当前皮肤材质').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('skin-07-mobile', '移动端查看已上传材质');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.once('dialog', (dialog) => void dialog.accept());
    await page
      .getByRole('button', { name: '移除', exact: true })
      .first()
      .click();
    await page.getByAltText('当前皮肤材质').waitFor({ state: 'detached' });
    await shot('skin-08-remove', '移除皮肤，确认回到空态且披风保留');
    await page.getByRole('button', { name: '账号安全' }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await visible('已退出');
    await shot('skin-09-logout', '退出登录');
    await page.getByRole('button', { name: '忘记密码' }).click();
    await page.getByRole('button', { name: '发送重置邮件' }).click();
    await visible('若该邮箱已注册，你将收到重置密码邮件');
    await shot('skin-10-reset', '申请重置密码；本地测试收件器接收验证码');
    await page.getByLabel('邮件验证码').fill(code);
    await page
      .getByLabel('新密码', { exact: true })
      .fill('Tutorial-Updated-2026');
    await page.getByRole('button', { name: '更新密码' }).click();
    await visible('密码已更新，请重新登录');
    await page
      .getByLabel('密码', { exact: true })
      .fill('Tutorial-Updated-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await visible('登录成功');
    await shot('skin-11-reset-login', '使用新密码重新登录成功');
    await page.getByRole('button', { name: '角色外观', exact: true }).click();
    await page.getByRole('button', { name: '管理角色', exact: true }).click();
    await page.getByLabel('角色名称', { exact: true }).fill('CampusBuilder');
    await shot('skin-16-player-create', '填写新增角色名称');
    await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await visible('操作已完成');
    await page
      .getByLabel('当前角色', { exact: true })
      .selectOption({ label: 'CampusBuilder' });
    await visible('上传材质后预览角色');
    await shot(
      'skin-17-player-empty',
      '切换到新增角色，原角色的材质不会被复制',
    );
    await page.getByRole('button', { name: '衣柜', exact: true }).click();
    await page
      .getByLabel('使用到角色', { exact: true })
      .selectOption({ label: 'CampusBuilder' });
    await page
      .locator('.texture-card')
      .filter({ has: page.getByRole('heading', { name: '皮肤', exact: true }) })
      .getByRole('button', { name: '使用', exact: true })
      .click();
    await visible('操作已完成');
    await shot('skin-17b-player-wardrobe', '从衣柜给指定角色应用皮肤');
    await page.getByRole('button', { name: '角色外观', exact: true }).click();
    await page
      .getByLabel('当前角色', { exact: true })
      .selectOption({ label: 'CampusBuilder' });
    await page.getByRole('button', { name: '向左旋转' }).waitFor();
    await page.getByRole('button', { name: '向左旋转' }).click();
    await shot('skin-18-player-preview', '通过按钮旋转实际三维模型');
    await page.getByRole('button', { name: '账号安全', exact: true }).click();
    await page.getByLabel('密钥名称').fill('演示设备');
    await page
      .getByLabel('当前密码', { exact: true })
      .fill('Tutorial-Updated-2026');
    await page.getByRole('button', { name: '添加通行密钥' }).click();
    await visible('演示设备');
    await shot(
      'skin-19-passkey-added',
      '使用测试认证器完成注册，服务端验证实际 WebAuthn 凭据',
    );
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await visible('登录成功');
    await shot('skin-20-passkey-login', '使用已注册的通行密钥重新登录');
    await page.getByRole('button', { name: '账号安全', exact: true }).click();
    await page
      .getByLabel('当前密码', { exact: true })
      .fill('Tutorial-Updated-2026');
    await page
      .locator('.passkey-row')
      .getByRole('button', { name: '移除' })
      .click();
    await visible('尚未添加通行密钥');
    await shot('skin-21-passkey-removed', '移除本地演示通行密钥');
    assert.deepEqual(errors, []);
    await writeFile(
      `${out}/skin-result.json`,
      JSON.stringify(
        {
          status: 'passed',
          screenshots: shots.length,
          browserErrors: errors,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`PASS: ${shots.length} screenshots`);
  } finally {
    await browser?.close();
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
