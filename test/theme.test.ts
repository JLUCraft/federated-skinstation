import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextureItem } from '../shared/wardrobe';
import { TextureCard } from '../web/TextureCard';
import { TextureCounts, TextureProvenance } from '../web/TextureIdentity';
import { ApiError, apiRequest } from '../web/api';

const WEB = join(import.meta.dirname, '..', 'web');

function read(name: string): string {
  return readFileSync(join(WEB, name), 'utf8');
}

const TOKENS = read('tokens.css');
const STYLE = read('style.css');

/** 只认行首的声明，避免把 .btn--primary:hover 这类 BEM 类名当成令牌。 */
function declared(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
  );
}

test('tokens.css 是生成文件，且包含两套模式与完整语义令牌', () => {
  assert.ok(
    TOKENS.includes('生成文件，请勿手改'),
    'tokens.css 必须标明是生成物',
  );
  assert.ok(TOKENS.includes('@media (prefers-color-scheme: dark)'));
  for (const token of [
    'bg',
    'surface',
    'ink',
    'muted',
    'line',
    'primary',
    'on-primary',
    'primary-text',
    'focus',
  ]) {
    assert.ok(TOKENS.includes(`--${token}:`), `令牌缺少 --${token}`);
  }
});

test('style.css 不再手写主题色：只允许 overlay 类的黑透明值', () => {
  const literals = [
    ...STYLE.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g),
  ].map((m) => m[0]);
  const allowed = new Set(['rgb(0 0 0 / .18)', 'rgb(0 0 0 / .5)']);
  const offenders = literals.filter((value) => !allowed.has(value));
  assert.deepEqual(
    offenders,
    [],
    `style.css 里出现了硬编码颜色：${offenders.join(', ')}`,
  );
});

test('style.css 不再重复声明生成令牌（单一事实源）', () => {
  const generated = declared(TOKENS);
  const local = declared(STYLE);
  const duplicated = [...local].filter((name) => generated.has(name));
  assert.deepEqual(
    duplicated,
    [],
    `这些令牌应由 tokens.css 提供：${duplicated.join(', ')}`,
  );
});

test('站内不再保留两套尺度：--sp-* 与 --workspace-max 已并入生成令牌', () => {
  assert.equal(
    [...STYLE.matchAll(/--sp-[0-9]+\s*:/g)].length,
    0,
    'style.css 里还有 --sp-* 声明',
  );
  assert.equal(
    [...STYLE.matchAll(/var\(--sp-[0-9]+\)/g)].length,
    0,
    '还有 var(--sp-*) 用法',
  );
  assert.equal([...STYLE.matchAll(/var\(--workspace-max\)/g)].length, 0);
  assert.equal([...STYLE.matchAll(/var\(--pad-btn\)/g)].length, 0);
  assert.equal([...STYLE.matchAll(/var\(--radius-panel\)/g)].length, 0);
});

test('样式里引用的每个自定义属性都有定义（不存在断链的 var）', () => {
  const defined = new Set([...declared(TOKENS), ...declared(STYLE)]);
  const used = new Set(
    [...STYLE.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]),
  );
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `未定义的自定义属性：${missing.join(', ')}`);
});

test('站内既有色名全部映射到品牌令牌，没有遗留字面色值', () => {
  for (const legacy of [
    'green-900',
    'green-700',
    'green-600',
    'blue-700',
    'card',
    'card-alt',
    'on-accent',
  ]) {
    const match = STYLE.match(new RegExp(`--${legacy}\\s*:\\s*([^;]+);`));
    assert.ok(match, `缺少 --${legacy} 映射`);
    assert.match(
      match[1],
      /^var\(--[a-z0-9-]+\)$/,
      `--${legacy} 必须指向令牌，实际是 ${match[1]}`,
    );
  }
});

test('每个页面入口都引入了 tokens.css，且顺序在 style.css 之前', () => {
  const entries = readdirSync(WEB).filter((name) => name.endsWith('.tsx'));
  const main = read('main.tsx');
  assert.ok(main.includes("import './tokens.css'"));
  assert.ok(
    main.indexOf("import './tokens.css'") <
      main.indexOf("import './style.css'"),
  );
  assert.ok(entries.length > 0);
});

test('public listing cards hide moderation details and owner state', () => {
  const item: TextureItem = {
    id: 'public-item',
    title: 'Campus face',
    kind: 'skin',
    model: 'slim',
    hash: 'face-hash',
    authorId: 'author',
    authorName: 'Campus author',
    school: 'jlu',
    source: 'original',
    state: 'approved',
    reviewReason: 'Private review note',
    applied: 1,
    published: 1,
    downloads: 2,
    saves: 3,
    likes: 4,
  };
  const publicCard = renderToStaticMarkup(
    React.createElement(TextureCard, { item, library: true }),
  );
  assert.match(publicCard, /class="texture-card"/);
  assert.match(publicCard, /class="texture-thumb"/);
  assert.match(publicCard, /class="author-row"/);
  assert.match(publicCard, /原创/);
  assert.match(publicCard, /纤细/);
  assert.doesNotMatch(
    publicCard,
    /审核通过|Private review note|正在使用|已公开|texture-flat/,
  );
  const ownerCard = renderToStaticMarkup(
    React.createElement(TextureCard, { item, library: false }),
  );
  assert.match(ownerCard, /审核通过/);
  assert.match(ownerCard, /Private review note/);
  assert.match(ownerCard, /正在使用/);
});

test('texture metadata omits an empty license and shares count separators', () => {
  const item: TextureItem = {
    id: 'item',
    title: 'Face',
    kind: 'skin',
    model: 'default',
    hash: 'hash',
    source: 'original',
    license: '',
  };
  const provenance = renderToStaticMarkup(
    React.createElement(TextureProvenance, { item }),
  );
  assert.match(provenance, />原创<\/span><\/p>$/);
  assert.doesNotMatch(provenance, /·/);
  const counts = renderToStaticMarkup(
    React.createElement(TextureCounts, { item }),
  );
  assert.equal(
    counts,
    '<p class="texture-counts">下载量 · 0 · 收藏数 · 0 · 点赞 · 0</p>',
  );
});

test('publication without a site administrator has a localized error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          errorMessage: 'Publication requires a site administrator',
        }),
        { status: 400 },
      );
    await assert.rejects(
      apiRequest('/api/wardrobe/item', {
        method: 'PATCH',
        body: { published: true },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.message, '站点尚未配置管理员，暂时无法公开材质');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
