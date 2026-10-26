import React, { useEffect, useRef } from 'react';
import { t } from './i18n';
import { normalizedSkin, SKIN_FACE } from './skin';
import type { TextureItem } from '../shared/wardrobe';

const AVATAR_SIZE = 64;

export function Avatar({ hash }: { hash?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    if (!hash) return;
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      const skin = normalizedSkin(img);
      const scale = skin.width / SKIN_FACE.grid;
      ctx.imageSmoothingEnabled = false;
      for (const left of SKIN_FACE.layers)
        ctx.drawImage(
          skin,
          left * scale,
          SKIN_FACE.top * scale,
          SKIN_FACE.size * scale,
          SKIN_FACE.size * scale,
          0,
          0,
          AVATAR_SIZE,
          AVATAR_SIZE,
        );
    };
    img.src = `/textures/${hash}`;
    return () => {
      active = false;
    };
  }, [hash]);
  return (
    <canvas
      className="skin-avatar"
      ref={ref}
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      role="img"
      aria-label={t('皮肤头像')}
    />
  );
}
export const SOURCE_LABELS = {
  unknown: t('来源未标注'),
  original: t('原创'),
  derivative: t('二创'),
  repost: t('转载'),
};
export const STATE_LABELS = {
  pending: t('待审核'),
  approved: t('审核通过'),
  rejected: t('已驳回'),
};
export function Author({ item }: { item: TextureItem }) {
  return (
    <div className="author-row">
      {item.avatar && <Avatar hash={item.avatar} />}
      <a href={`/portal/u/${item.authorId}`}>{item.authorName}</a>
      <span>{item.school?.toUpperCase()}</span>
    </div>
  );
}

export function TextureProvenance({ item }: { item: TextureItem }) {
  return (
    <p className="texture-provenance badge-row">
      <span className="status-pill">
        {SOURCE_LABELS[item.source ?? 'unknown']}
      </span>
      {item.license && <span>{item.license}</span>}
    </p>
  );
}

export function TextureCounts({ item }: { item: TextureItem }) {
  return (
    <p className="texture-counts">
      {[
        `${t('下载量')} · ${item.downloads ?? 0}`,
        `${t('收藏数')} · ${item.saves ?? 0}`,
        `${t('点赞')} · ${item.likes ?? 0}`,
      ].join(' · ')}
    </p>
  );
}
