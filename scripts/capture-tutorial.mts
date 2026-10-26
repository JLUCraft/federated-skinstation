import { createServer } from 'node:net';
import { build } from '../server/app.ts';
import { TEXTURE_PAGE_SIZE } from '../shared/wardrobe.ts';
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
  const siteAdmins: string[] = [];
  const app = await build(
    {
      siteAdmins,
      listen: '127.0.0.1',
      port: 0,
      origin,
      database: `${temp}/db`,
      textures: `${temp}/textures`,
      signingKey: `${temp}/key.pem`,
      schools: { jlu: { emailDomains: ['school.test'] } },
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
    const adminAccount = {
      email: 'moderator@school.test',
      name: 'SiteModerator',
      school: 'jlu',
      password: 'Moderator-Only-2026',
    };
    await app.inject({
      method: 'POST',
      url: '/api/email/start',
      payload: adminAccount,
    });
    await app.inject({
      method: 'POST',
      url: '/api/email/confirm',
      payload: { email: adminAccount.email, code },
    });
    const adminLogin = (
      await app.inject({
        method: 'POST',
        url: '/authserver/authenticate',
        payload: {
          username: adminAccount.email,
          password: adminAccount.password,
        },
      })
    ).json();
    const adminHeaders = { authorization: `Bearer ${adminLogin.accessToken}` };
    const adminMe = (
      await app.inject({ url: '/api/me', headers: adminHeaders })
    ).json();
    siteAdmins.push(adminMe.id);
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
    if (['community', 'avatar'].includes(process.env.TUTORIAL_SCOPE ?? '')) {
      // Isolated fixtures keep this recheck focused on the changed community UI.
      const faceSkin = (
        height: number,
        hat = true,
        opaque = false,
        scale = 1,
      ) => {
        const skin = new PNG({ width: 64 * scale, height: height * scale });
        if (opaque)
          for (let pixel = 3; pixel < skin.data.length; pixel += 4)
            skin.data[pixel] = 255;
        for (const [left, color] of [
          [8, [220, 40, 20]],
          [40, [20, 40, 240]],
        ] as const) {
          for (let y = 8 * scale; y < 16 * scale; y++)
            for (let x = left * scale; x < (left + 8) * scale; x++) {
              if (left === 40 && !hat) continue;
              const pixel = (y * skin.width + x) * 4;
              skin.data[pixel] = color[0];
              skin.data[pixel + 1] = color[1];
              skin.data[pixel + 2] = color[2];
              skin.data[pixel + 3] = 255;
            }
        }
        return PNG.sync.write(skin);
      };
      const uploadFace = async (
        height: number,
        hat = true,
        opaque = false,
        scale = 1,
      ) => {
        const boundary = 'community-browser-fixture';
        const uploaded = await app.inject({
          method: 'PUT',
          url: `/api/user/profile/${adminMe.profileId}/skin`,
          headers: {
            ...adminHeaders,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="face.png"\r\nContent-Type: image/png\r\n\r\n`,
            ),
            faceSkin(height, hat, opaque, scale),
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
        });
        assert.equal(uploaded.statusCode, 204);
      };
      await uploadFace(32);
      const entry = (
        await app.inject({ url: '/api/wardrobe', headers: adminHeaders })
      ).json().items[0];
      await page.goto(`${address}/portal/`);
      await page
        .getByLabel('学校邮箱', { exact: true })
        .fill(adminAccount.email);
      await page
        .getByLabel('密码', { exact: true })
        .fill(adminAccount.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.locator('.user-chip').waitFor();
      if (process.env.TUTORIAL_SCOPE === 'avatar') {
        const cases = [
          [32, true, false, [20, 40, 240, 255], 'avatar-32-hat', 1],
          [
            32,
            false,
            false,
            [220, 40, 20, 255],
            'avatar-32-transparent-hat',
            1,
          ],
          [64, true, false, [20, 40, 240, 255], 'avatar-64-hat', 1],
          [32, true, true, [220, 40, 20, 255], 'avatar-32-opaque', 1],
          [64, true, true, [220, 40, 20, 255], 'avatar-64-opaque', 1],
          [32, true, false, [20, 40, 240, 255], 'avatar-128x64-hat', 2],
          [64, true, true, [220, 40, 20, 255], 'avatar-128x128-opaque', 2],
        ] as const;
        const results: object[] = [];
        let passed = true;
        for (const [height, hat, opaque, color, name, scale] of cases) {
          if (process.env.AVATAR_CASES === 'opaque' && !opaque) continue;
          if (name !== 'avatar-32-hat')
            await uploadFace(height, hat, opaque, scale);
          const current = (
            await app.inject({ url: '/api/wardrobe', headers: adminHeaders })
          ).json().items[0];
          const selected = await app.inject({
            method: 'PUT',
            url: '/api/me/avatar',
            headers: adminHeaders,
            payload: { item: current.id },
          });
          assert.equal(selected.statusCode, 200);
          await page.evaluate(() =>
            window.dispatchEvent(new Event('avatar-changed')),
          );
          await page
            .getByRole('button', { name: '角色外观', exact: true })
            .click();
          await page.getByRole('button', { name: '衣柜', exact: true }).click();
          await page.waitForFunction(() => {
            const avatar = document.querySelector<HTMLCanvasElement>(
              '.user-chip .skin-avatar',
            );
            const thumb = document.querySelector<HTMLCanvasElement>(
              '.texture-card .texture-thumb',
            );
            return (
              avatar?.getContext('2d')?.getImageData(0, 0, 1, 1).data[3] ===
                255 &&
              thumb?.getContext('2d')?.getImageData(thumb.width / 4, 0, 1, 1)
                .data[3] === 255
            );
          });
          const actual = await page.evaluate(() => {
            const avatar = document.querySelector<HTMLCanvasElement>(
              '.user-chip .skin-avatar',
            )!;
            const thumb = document.querySelector<HTMLCanvasElement>(
              '.texture-card .texture-thumb',
            )!;
            return {
              avatar: Array.from(
                avatar.getContext('2d')!.getImageData(0, 0, 1, 1).data,
              ),
              thumbnail: Array.from(
                thumb.getContext('2d')!.getImageData(thumb.width / 4, 0, 1, 1)
                  .data,
              ),
            };
          });
          const matches = [actual.avatar, actual.thumbnail].every((pixel) =>
            pixel.every((value, index) => value === color[index]),
          );
          passed &&= matches;
          results.push({
            name,
            expected: color,
            actual,
            status: matches ? 'passed' : 'failed',
          });
          await shot(
            name,
            `${64 * scale} by ${height * scale} skin: ${opaque ? 'fully opaque input normalizes its head overlay to show the red face' : hat ? 'a transparent background preserves the blue head overlay' : 'transparent head overlay pixels reveal the red face'}`,
          );
        }
        assert.deepEqual(errors, []);
        await writeFile(
          `${out}/skin-result.json`,
          JSON.stringify(
            {
              status: passed ? 'passed' : 'failed',
              scope: 'avatar',
              cases: results,
              screenshots: shots.length,
              browserErrors: errors,
              finishedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        assert.ok(
          passed,
          `Avatar pixels differed from normalized skin expectations; see ${out}/skin-result.json`,
        );
        console.log(`PASS: avatar pixels, ${shots.length} screenshots`);
        return;
      }
      assert.equal(await page.locator('.user-chip .skin-avatar').count(), 0);
      await page
        .getByRole('button', { name: '站内通知', exact: true })
        .waitFor();
      await page.getByRole('button', { name: '衣柜', exact: true }).click();
      await page.getByText('管理材质', { exact: true }).click();
      await page.getByLabel('名称', { exact: true }).fill('Campus face');
      await page
        .getByLabel('材质来源', { exact: true })
        .selectOption('original');
      await page.getByLabel('许可与署名', { exact: true }).fill('');
      await page.getByLabel(/^标签/).fill('campus');
      await page.getByLabel('公开到皮肤库', { exact: true }).check();
      siteAdmins.splice(0);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: '站点尚未配置管理员，暂时无法公开材质' })
        .waitFor();
      siteAdmins.push(adminMe.id);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('待审核', { exact: true }).waitFor();
      await page.getByRole('button', { name: '站点管理', exact: true }).click();
      await page.getByLabel('处理理由').fill('Private moderation note');
      await page.getByRole('button', { name: '提交审核', exact: true }).click();
      await page.getByText('没有待处理材质', { exact: true }).waitFor();
      await page.getByLabel('公告标题').fill('Campus notice');
      await page.getByLabel('公告内容').fill('Announcement refresh check');
      await page.getByLabel('默认展开').check();
      await page.getByRole('button', { name: '发布公告', exact: true }).click();
      await page
        .locator('.announcement summary')
        .filter({ hasText: 'Campus notice' })
        .waitFor();
      assert.equal(
        await page
          .locator('.announcement .disclosure-trigger')
          .evaluate((node) => getComputedStyle(node).listStyleType),
        'none',
      );
      await shot(
        'community-announcement-disclosure',
        'Announcements use the shared disclosure trigger without the browser marker',
      );
      const { DatabaseSync } = await import('node:sqlite');
      await page.getByRole('button', { name: '衣柜', exact: true }).click();
      await page.getByText('管理材质', { exact: true }).click();
      await page.getByRole('button', { name: '设为头像', exact: true }).click();
      const avatarPixel = async (expected: number[]) => {
        await page.waitForFunction((rgba: number[]) => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '.user-chip .skin-avatar',
          );
          const pixel = canvas?.getContext('2d')?.getImageData(0, 0, 1, 1).data;
          return pixel && rgba.every((value, index) => pixel[index] === value);
        }, expected);
      };
      await avatarPixel([20, 40, 240, 255]);
      await page.waitForFunction(() => {
        const canvas =
          document.querySelector<HTMLCanvasElement>('.texture-thumb');
        const pixel = canvas?.getContext('2d')?.getImageData(4, 0, 1, 1).data;
        return (
          pixel?.[0] === 20 &&
          pixel[1] === 40 &&
          pixel[2] === 240 &&
          pixel[3] === 255
        );
      });
      await shot(
        'community-avatar-32-overlay',
        'A 64 by 32 avatar and thumbnail retain the head overlay',
      );
      await uploadFace(64);
      const modernEntry = (
        await app.inject({ url: '/api/wardrobe', headers: adminHeaders })
      )
        .json()
        .items.find((i: { id: string }) => i.id !== entry.id);
      assert.ok(modernEntry);
      const avatarChanged = await app.inject({
        method: 'PUT',
        url: '/api/me/avatar',
        headers: adminHeaders,
        payload: { item: modernEntry.id },
      });
      assert.equal(avatarChanged.statusCode, 200);
      await page.evaluate(() =>
        window.dispatchEvent(new Event('avatar-changed')),
      );
      await avatarPixel([20, 40, 240, 255]);
      await shot(
        'community-avatar-overlay',
        'A 64 by 64 skin avatar includes its face overlay',
      );

      await page.getByRole('button', { name: /^站内通知/ }).click();
      await page
        .getByText('Private moderation note', { exact: false })
        .waitFor();
      assert.equal(
        await page
          .getByRole('navigation', { name: '通知分页', exact: true })
          .count(),
        0,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page
          .locator('.notification-row')
          .first()
          .evaluate((row) => {
            const meta = row
              .querySelector('.notice-meta')!
              .getBoundingClientRect();
            const action = row
              .querySelector('.notice-action')!
              .getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            return {
              overlap:
                meta.left < action.right &&
                action.left < meta.right &&
                meta.top < action.bottom &&
                action.top < meta.bottom,
              contained:
                action.right <= bounds.right && action.left >= bounds.left,
              overflow:
                document.documentElement.scrollWidth > window.innerWidth,
            };
          });
        assert.deepEqual(layout, {
          overlap: false,
          contained: true,
          overflow: false,
        });
        await shot(
          `community-notifications-${width}`,
          'Notifications separate text, time, and action at this viewport',
        );
      }
      await page.getByRole('button', { name: '标为已读', exact: true }).click();
      await page
        .getByRole('button', { name: '站内通知', exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: /^站内通知 · 0$/ }).count(),
        0,
      );
      const noticesDb = new DatabaseSync(`${temp}/db`);
      try {
        const insert = noticesDb.prepare(
          'INSERT INTO notifications(id,account,kind,item,title,detail,created_at) VALUES(?,?,?,?,?,?,?)',
        );
        for (let index = 0; index < TEXTURE_PAGE_SIZE; index++)
          insert.run(
            `notice-${index}`,
            adminMe.id,
            'like',
            entry.id,
            `Like notice ${index}`,
            '',
            Math.floor(Date.now() / 1000) + index,
          );
      } finally {
        noticesDb.close();
      }
      await page.getByRole('button', { name: '衣柜', exact: true }).click();
      await page.getByRole('button', { name: /^站内通知/ }).click();
      await page
        .getByRole('navigation', { name: '通知分页', exact: true })
        .getByRole('button', { name: '下一页', exact: true })
        .click();
      await page
        .getByText('Private moderation note', { exact: false })
        .waitFor();
      const noticePager = page.getByRole('navigation', {
        name: '通知分页',
        exact: true,
      });
      assert.equal(
        await noticePager
          .getByRole('button', { name: '上一页', exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        await noticePager
          .getByRole('button', { name: '下一页', exact: true })
          .isDisabled(),
        true,
      );
      await noticePager
        .getByRole('button', { name: '上一页', exact: true })
        .click();
      await page
        .getByText(`Like notice ${TEXTURE_PAGE_SIZE - 1}`, { exact: true })
        .waitFor();

      await page.getByRole('button', { name: '皮肤库', exact: true }).click();
      await page.locator('.texture-card').waitFor();
      assert.equal(
        await page
          .locator('.texture-card')
          .getByText('审核通过', { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator('.texture-card')
          .getByText('Private moderation note', { exact: false })
          .count(),
        0,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await shot(
          `community-library-card-${width}`,
          'The public library uses the shared thumbnail, provenance, and count components',
        );
      }
      await page.getByRole('link', { name: '详情与分享', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Campus face', exact: true })
        .waitFor();
      assert.equal(
        (await page.locator('.texture-provenance').innerText()).trim(),
        '原创',
      );
      assert.equal(
        await page
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('download'),
        'Campus face.png',
      );
      assert.equal(
        await page.getByText('审核通过', { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.locator('.texture-counts').innerText(),
        '下载量 · 0 · 收藏数 · 0 · 点赞 · 0',
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await shot(
          `community-public-detail-${width}`,
          'Public detail shares provenance and counts and retains the download filename',
        );
      }
      await page
        .locator('.author-row')
        .getByRole('link', { name: adminAccount.name, exact: true })
        .click();
      await page
        .locator('.wardrobe-grid .texture-card .texture-thumb')
        .waitFor();
      assert.equal(
        await page.locator('.texture-card .texture-provenance').count(),
        1,
      );
      assert.equal(
        await page
          .locator('.texture-card .status-pill')
          .getByText('审核通过', { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.locator('.texture-card .texture-flat').count(),
        0,
      );
      const authorGap = await page
        .locator('.texture-card .author-row')
        .evaluate((row) => parseFloat(getComputedStyle(row).columnGap));
      assert.ok(authorGap > 0);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          ),
          false,
        );
        await shot(
          `community-public-author-${width}`,
          'Public author uses the same thumbnail, card, badges, and counts as the library',
        );
      }
      assert.deepEqual(errors, []);
      await writeFile(
        `${out}/skin-result.json`,
        JSON.stringify(
          {
            status: 'passed',
            scope: 'community',
            screenshots: shots.length,
            browserErrors: errors,
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log(`PASS: community recheck, ${shots.length} screenshots`);
      return;
    }
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
    await shot('skin-13-publish', 'Submit a texture for human review');
    assert.equal(
      (await app.inject({ url: '/api/library' })).json().items.length,
      0,
    );
    const moderation = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await moderation.goto(`${address}/portal/`);
    await moderation
      .getByLabel('学校邮箱', { exact: true })
      .fill(adminAccount.email);
    await moderation
      .getByLabel('密码', { exact: true })
      .fill(adminAccount.password);
    await moderation.getByRole('button', { name: '登录', exact: true }).click();
    await moderation
      .getByRole('button', { name: '站点管理', exact: true })
      .click();
    await moderation
      .getByLabel('处理理由')
      .fill('Reviewed for campus publication');
    await moderation
      .getByRole('button', { name: '提交审核', exact: true })
      .click();
    await moderation.getByText('没有待处理材质', { exact: true }).waitFor();
    await moderation.getByLabel('公告标题').fill('校园维护通知');
    await moderation
      .getByLabel('公告内容')
      .fill('Maintenance announcement for launcher and web readers.');
    await moderation.getByLabel('严重程度').selectOption('warning');
    await moderation.getByLabel('默认展开').check();
    await moderation
      .getByRole('button', { name: '发布公告', exact: true })
      .click();
    await moderation
      .getByRole('button', { name: '编辑公告', exact: true })
      .waitFor();
    await moderation.screenshot({
      path: `${out}/community-admin.png`,
      fullPage: true,
    });
    await moderation.close();
    await page.getByRole('button', { name: '皮肤库', exact: true }).click();
    await page
      .getByRole('heading', { name: '校园披风', exact: true })
      .waitFor();
    await shot('skin-14-library', '公开材质进入皮肤库，可以下载或收藏');
    // The publisher already owns it, so the library offers no second copy.
    await page.getByRole('button', { name: '已在衣柜', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: '收藏到衣柜', exact: true })
        .count(),
      0,
    );
    await shot(
      'skin-15-collected',
      'Own published items remain in the wardrobe',
    );
    await page.getByLabel('排序', { exact: true }).selectOption('downloads');
    await page.getByLabel('学校', { exact: true }).selectOption('jlu');
    await page.getByRole('link', { name: '详情与分享', exact: true }).click();
    await page.getByRole('button', { name: '举报', exact: true }).waitFor();
    await shot(
      'community-detail',
      'Open a shareable texture detail without losing the web session',
    );
    const deepLink = page.url();
    const guest = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await guest.goto(deepLink);
    await guest
      .getByRole('heading', { name: '校园披风', exact: true })
      .waitFor();
    await guest.getByRole('link', { name: 'CampusGuide', exact: true }).click();
    await guest
      .getByRole('heading', { name: 'CampusGuide', exact: true })
      .waitFor();
    assert.ok(
      await guest.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await guest.screenshot({
      path: `${out}/community-author-mobile.png`,
      fullPage: true,
    });
    await guest.reload();
    await guest
      .getByRole('heading', { name: 'CampusGuide', exact: true })
      .waitFor();
    await guest.close();
    await page.getByRole('button', { name: /^站内通知/ }).click();
    await page.getByText('审核结果', { exact: true }).waitFor();
    await shot(
      'community-notifications',
      'Review notifications belong to the uploading account',
    );
    await page.getByRole('button', { name: '衣柜', exact: true }).click();
    const skinCard = page.locator('.texture-card').filter({
      has: page.getByRole('heading', { name: '皮肤', exact: true }),
    });
    await skinCard.getByText('管理材质', { exact: true }).click();
    await skinCard
      .getByRole('button', { name: '设为头像', exact: true })
      .click();
    await visible('操作已完成');
    await page.locator('.user-chip .skin-avatar').waitFor();
    await shot(
      'community-avatar',
      'Choose a wardrobe skin for the site avatar',
    );
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
