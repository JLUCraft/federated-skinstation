import React, { useEffect, useRef, useState } from 'react';
import { SkinPreview } from './SkinPreview';
import type { TextureItem } from '../shared/wardrobe';
import { Author, TextureProvenance } from './TextureIdentity';
import { t } from './i18n';

export const textureSrc = (item: TextureItem) => `/textures/${item.hash}`;
export const textureTitle = (item: TextureItem) =>
  item.title || (item.kind === 'skin' ? t('皮肤') : t('披风'));

const COPY_NOTICE_MS = 2000;

/** Modal detail view: 3D preview, provenance and the actions the card also offers. */
export function TextureDialog({
  item,
  actions,
  onClose,
}: {
  item: TextureItem;
  actions: React.ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const absolute = new URL(textureSrc(item), window.location.origin).href;
  return (
    <dialog
      ref={dialog}
      className="texture-dialog"
      aria-labelledby="texture-dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="texture-dialog-body">
        <div className="texture-dialog-head">
          <h2 className="section-title" id="texture-dialog-title">
            {textureTitle(item)}
          </h2>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => dialog.current?.close()}
          >
            {t('关闭')}
          </button>
        </div>
        <SkinPreview
          textures={[item]}
          textureUrl={() => textureSrc(item)}
          emptyText={t('无法预览此材质')}
        />
        {item.public && <Author item={item} />}
        <TextureProvenance item={item} />
        {item.public && (
          <a href={`/portal/library/${item.id}`}>{t('详情与分享')}</a>
        )}
        <dl className="detail-list">
          <div className="detail-row">
            <dt className="detail-term">{t('类型')}</dt>
            <dd className="detail-value">
              {item.kind === 'skin' ? t('皮肤') : t('披风')}
            </dd>
          </div>
          {item.kind === 'skin' && (
            <div className="detail-row">
              <dt className="detail-term">{t('手臂模型')}</dt>
              <dd className="detail-value">
                {item.model === 'slim' ? t('纤细') : t('标准')}
              </dd>
            </div>
          )}
          <div className="detail-row">
            <dt className="detail-term">{t('材质哈希')}</dt>
            <dd className="detail-value detail-hash">{item.hash}</dd>
          </div>
        </dl>
        <div className="actions">
          {actions}
          <a
            className="btn btn--secondary"
            href={item.public ? `/api/library/${item.id}/download` : absolute}
            download={`${textureTitle(item)}.png`}
          >
            {t('下载')}
          </a>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(
                  item.public
                    ? new URL(
                        `/portal/library/${item.id}`,
                        window.location.origin,
                      ).href
                    : absolute,
                )
                .then(() => setCopied(true))
            }
          >
            {copied ? t('已复制') : t('复制材质链接')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
