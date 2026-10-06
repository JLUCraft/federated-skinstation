import React, { useEffect, useRef, useState } from 'react';
import type { SkinViewer } from 'skinview3d';
import type { Texture } from '../shared/wardrobe';
import { t } from './i18n';
const TURN = Math.PI / 4;
type Motion = 'still' | 'walk' | 'run';
const MOTIONS: Motion[] = ['still', 'walk', 'run'];
const MOTION_LABELS: Record<Motion, string> = {
  still: t('静止'),
  walk: t('行走'),
  run: t('奔跑'),
};
const defaultTextureUrl = (texture: Texture) => `/textures/${texture.hash}`;
async function applyMotion(viewer: SkinViewer, motion: Motion) {
  const { WalkingAnimation, RunningAnimation } = await import('skinview3d');
  viewer.animation =
    motion === 'walk'
      ? new WalkingAnimation()
      : motion === 'run'
        ? new RunningAnimation()
        : null;
}
export function SkinPreview({
  textures,
  textureUrl = defaultTextureUrl,
  emptyText = t('上传材质后预览角色'),
}: {
  textures: Texture[];
  textureUrl?: (texture: Texture) => string;
  emptyText?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null),
    viewer = useRef<SkinViewer | null>(null),
    motionRef = useRef<Motion>('still');
  const [failed, setFailed] = useState(false),
    [loading, setLoading] = useState(false),
    [rotating, setRotating] = useState(false),
    [motion, setMotion] = useState<Motion>('still');
  const skin = textures.find((x) => x.kind === 'skin'),
    cape = textures.find((x) => x.kind === 'cape');
  useEffect(() => {
    if (!skin && !cape) return;
    let cancelled = false;
    let active: SkinViewer | undefined;
    let observer: ResizeObserver | undefined;
    setLoading(true);
    setFailed(false);
    setRotating(false);
    void import('skinview3d')
      .then(async ({ SkinViewer }) => {
        if (cancelled || !canvas.current || !container.current) return;
        active = new SkinViewer({
          canvas: canvas.current,
          width: container.current.clientWidth,
          height: container.current.clientHeight,
        });
        viewer.current = active;
        active.controls.enablePan = false;
        observer = new ResizeObserver(() => {
          if (active && container.current)
            active.setSize(
              container.current.clientWidth,
              container.current.clientHeight,
            );
        });
        observer.observe(container.current);
        await Promise.all([
          skin
            ? active.loadSkin(textureUrl(skin), {
                model: skin.model === 'slim' ? 'slim' : 'default',
              })
            : Promise.resolve(),
          cape ? active.loadCape(textureUrl(cape)) : Promise.resolve(),
        ]);
        if (!cancelled) {
          setLoading(false);
          await applyMotion(active, motionRef.current);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      observer?.disconnect();
      active?.dispose();
      viewer.current = null;
    };
  }, [skin?.hash, skin?.model, cape?.hash]);
  useEffect(() => {
    motionRef.current = motion;
    if (viewer.current) void applyMotion(viewer.current, motion);
  }, [motion]);
  if (!skin && !cape)
    return <div className="skin-preview-empty">{emptyText}</div>;
  return (
    <div className="skin-preview">
      <div className="skin-preview-stage" ref={container}>
        <canvas
          ref={canvas}
          className="skin-preview-canvas"
          aria-label={t('角色三维预览')}
          role="img"
        />
        {loading && (
          <p className="skin-preview-message" role="status">
            {t('正在加载…')}
          </p>
        )}
        {failed && (
          <p className="skin-preview-message" role="alert">
            {t('三维预览不可用，仍可上传和使用材质')}
          </p>
        )}
      </div>
      <div className="actions">
        <label className="preview-motion">
          {t('动作')}
          <select
            className="input"
            value={motion}
            disabled={loading || failed}
            onChange={(e) => setMotion(e.target.value as Motion)}
          >
            {MOTIONS.map((id) => (
              <option key={id} value={id}>
                {MOTION_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn--secondary"
          disabled={loading || failed}
          onClick={() => {
            if (viewer.current) viewer.current.playerObject.rotation.y -= TURN;
          }}
        >
          {t('向左旋转')}
        </button>
        <button
          className="btn btn--secondary"
          disabled={loading || failed}
          onClick={() => {
            if (viewer.current) viewer.current.playerObject.rotation.y += TURN;
          }}
        >
          {t('向右旋转')}
        </button>
        <button
          className="btn btn--secondary"
          disabled={loading || failed}
          aria-pressed={rotating}
          onClick={() => {
            if (viewer.current) viewer.current.autoRotate = !rotating;
            setRotating(!rotating);
          }}
        >
          {t('自动旋转')}
        </button>
      </div>
    </div>
  );
}
