import React, { useEffect, useRef, useState } from 'react';
import type { TextureKind } from '../shared/wardrobe';
import { t } from './i18n';
import { normalizedSkin, SKIN_FACE } from './skin';

/** Skin sheets are laid out on a 64-unit grid; every rectangle below is in those units. */
const SKIN_GRID = SKIN_FACE.grid;
const CAPE_LEGACY_GRID = 22;
const CAPE_LEGACY_ROWS = 17;
const FIGURE_WIDTH = 16;
const FIGURE_HEIGHT = 32;
const CAPE_FACE = { x: 1, y: 1, width: 10, height: 16 };

type Rect = [x: number, y: number, width: number, height: number];
/** One normalized body part: source rectangle and destination origin. */
type Part = { src: Rect; at: [number, number] };

function skinParts(slim: boolean): Part[] {
  const arm = slim ? 3 : 4;
  const armY = 12;
  const parts: Part[] = [
    {
      src: [SKIN_FACE.layers[0], SKIN_FACE.top, SKIN_FACE.size, SKIN_FACE.size],
      at: [4, 0],
    },
    { src: [20, 20, 8, 12], at: [4, 8] },
    { src: [44, 20, arm, armY], at: [4 - arm, 8] },
    { src: [4, 20, 4, 12], at: [4, 20] },
    { src: [36, 52, arm, armY], at: [12, 8] },
    { src: [20, 52, 4, 12], at: [8, 20] },
  ];
  const layers: Part[] = [
    {
      src: [SKIN_FACE.layers[1], SKIN_FACE.top, SKIN_FACE.size, SKIN_FACE.size],
      at: [4, 0],
    },
  ];
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
  image: HTMLCanvasElement,
  slim: boolean,
) {
  const unit = image.width / SKIN_GRID;
  for (const part of skinParts(slim)) {
    const [sx, sy, sw, sh] = part.src;
    const [dx, dy] = part.at;
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

function capeUnit(image: HTMLImageElement) {
  const legacyShape =
    image.width % CAPE_LEGACY_GRID === 0 &&
    image.height === (image.width / CAPE_LEGACY_GRID) * CAPE_LEGACY_ROWS;
  return image.width / (legacyShape ? CAPE_LEGACY_GRID : SKIN_GRID);
}

/**
 * Flat front view of a texture, drawn from the raw PNG so listings need no
 * server-side rendering. Callers that already name the surrounding control
 * omit `label`, which makes the canvas decorative.
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
  label?: string;
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
      if (kind === 'skin') {
        const skin = normalizedSkin(image);
        const unit = skin.width / SKIN_GRID;
        target.width = FIGURE_WIDTH * unit;
        target.height = FIGURE_HEIGHT * unit;
        ctx.imageSmoothingEnabled = false;
        drawSkin(ctx, skin, slim);
      } else {
        const unit = capeUnit(image);
        target.width = CAPE_FACE.width * unit;
        target.height = CAPE_FACE.height * unit;
        ctx.imageSmoothingEnabled = false;
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
  ) : label ? (
    <canvas
      ref={canvas}
      className="texture-thumb"
      role="img"
      aria-label={label}
    />
  ) : (
    <canvas ref={canvas} className="texture-thumb" aria-hidden="true" />
  );
}
