import React, { useEffect, useRef, useState } from 'react';
import type { TextureKind } from '../shared/wardrobe';
import { t } from './i18n';

/** Skin sheets are laid out on a 64-unit grid; every rectangle below is in those units. */
const SKIN_GRID = 64;
const CAPE_LEGACY_GRID = 22;
const CAPE_LEGACY_ROWS = 17;
const FIGURE_WIDTH = 16;
const FIGURE_HEIGHT = 32;
const CAPE_FACE = { x: 1, y: 1, width: 10, height: 16 };

type Rect = [x: number, y: number, width: number, height: number];
/** One body part: source rectangle, destination origin, optional mirror for pre-1.8 sheets. */
type Part = { src: Rect; at: [number, number]; mirror?: Rect };

function skinParts(slim: boolean, modern: boolean): Part[] {
  const arm = slim ? 3 : 4;
  const armY = 12;
  const parts: Part[] = [
    { src: [8, 8, 8, 8], at: [4, 0] },
    { src: [20, 20, 8, 12], at: [4, 8] },
    { src: [44, 20, arm, armY], at: [4 - arm, 8] },
    { src: [4, 20, 4, 12], at: [4, 20] },
    modern
      ? { src: [36, 52, arm, armY], at: [12, 8] }
      : { src: [44, 20, arm, armY], at: [12, 8], mirror: [44, 20, arm, armY] },
    modern
      ? { src: [20, 52, 4, 12], at: [8, 20] }
      : { src: [4, 20, 4, 12], at: [8, 20], mirror: [4, 20, 4, 12] },
  ];
  const layers: Part[] = [{ src: [40, 8, 8, 8], at: [4, 0] }];
  if (modern)
    layers.push(
      { src: [20, 36, 8, 12], at: [4, 8] },
      { src: [44, 36, arm, armY], at: [4 - arm, 8] },
      { src: [52, 52, arm, armY], at: [12, 8] },
      { src: [4, 36, 4, 12], at: [4, 20] },
      { src: [4, 52, 4, 12], at: [8, 20] },
    );
  return [...parts, ...layers];
}

function drawSkin(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  slim: boolean,
) {
  const unit = image.width / SKIN_GRID;
  const modern = image.height >= image.width;
  for (const part of skinParts(slim, modern)) {
    const [sx, sy, sw, sh] = part.src;
    const [dx, dy] = part.at;
    if (part.mirror) {
      ctx.save();
      ctx.translate((dx + sw) * unit, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(
        image,
        sx * unit,
        sy * unit,
        sw * unit,
        sh * unit,
        0,
        dy * unit,
        sw * unit,
        sh * unit,
      );
      ctx.restore();
    } else {
      ctx.drawImage(
        image,
        sx * unit,
        sy * unit,
        sw * unit,
        sh * unit,
        dx * unit,
        dy * unit,
        sw * unit,
        sh * unit,
      );
    }
  }
}

function capeUnit(image: HTMLImageElement) {
  const legacyShape =
    image.width % CAPE_LEGACY_GRID === 0 &&
    image.height === (image.width / CAPE_LEGACY_GRID) * CAPE_LEGACY_ROWS;
  return image.width / (legacyShape ? CAPE_LEGACY_GRID : SKIN_GRID);
}

/**
 * Flat front view of a texture, drawn from the raw PNG so listings need no server-side
 * rendering and remote federation textures look the same as local ones.
 */
export function TextureThumb({
  url,
  kind,
  slim,
  label,
}: {
  url: string;
  kind: TextureKind;
  slim: boolean;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const target = canvas.current;
    const ctx = target?.getContext('2d');
    if (!target || !ctx) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      ctx.imageSmoothingEnabled = false;
      if (kind === 'skin') {
        const unit = image.width / SKIN_GRID;
        target.width = FIGURE_WIDTH * unit;
        target.height = FIGURE_HEIGHT * unit;
        drawSkin(ctx, image, slim);
      } else {
        const unit = capeUnit(image);
        target.width = CAPE_FACE.width * unit;
        target.height = CAPE_FACE.height * unit;
        ctx.drawImage(
          image,
          CAPE_FACE.x * unit,
          CAPE_FACE.y * unit,
          CAPE_FACE.width * unit,
          CAPE_FACE.height * unit,
          0,
          0,
          target.width,
          target.height,
        );
      }
    };
    image.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, kind, slim]);
  return failed ? (
    <span className="thumb-fallback">{t('预览不可用')}</span>
  ) : (
    <canvas
      ref={canvas}
      className={`texture-thumb texture-thumb--${kind}`}
      role="img"
      aria-label={label}
    />
  );
}
