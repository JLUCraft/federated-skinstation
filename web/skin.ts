import { loadSkinToCanvas, type TextureSource } from 'skinview-utils';

export const SKIN_FACE = {
  grid: 64,
  size: 8,
  top: 8,
  layers: [8, 40],
} as const;

/** Use the same texture normalization as the 3D viewer before cropping. */
export function normalizedSkin(image: TextureSource): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  loadSkinToCanvas(canvas, image);
  return canvas;
}
