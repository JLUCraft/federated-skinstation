import React, { useEffect, useRef } from 'react';
import { MAX_TAGS, MAX_TAG_LENGTH } from '../shared/wardrobe';
import type { TextureItem } from '../shared/wardrobe';
import { MAX_LICENSE_LENGTH, SOURCES } from '../shared/community';
import { STATE_LABELS, SOURCE_LABELS } from './TextureIdentity';
import { textureTitle, textureSrc } from './TextureDialog';
import { t, tf } from './i18n';

export type TextureEditInput = {
  title: string;
  tags: string[];
  source: string;
  license: string;
  published: boolean;
};

/**
 * Wardrobe material editor: a right-side drawer with three independent blocks
 * (metadata, site avatar, library publication) and a separated danger zone.
 */
export function TextureEditorDrawer({
  item,
  busy,
  onClose,
  onSave,
  onSetAvatar,
  onRemove,
}: {
  item: TextureItem;
  busy: boolean;
  onClose: () => void;
  onSave: (input: TextureEditInput) => void;
  onSetAvatar: () => void;
  onRemove: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="texture-drawer"
      aria-labelledby="texture-drawer-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="texture-drawer-body">
        <div className="texture-drawer-head">
          <h2 className="section-title" id="texture-drawer-title">
            {t('管理材质')}
          </h2>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => dialog.current?.close()}
          >
            {t('关闭')}
          </button>
        </div>

        <form
          id="texture-metadata"
          className="editor-block"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onSave({
              title: String(form.get('title') ?? ''),
              source: String(form.get('source') ?? 'unknown'),
              license: String(form.get('license') ?? ''),
              published: form.get('published') === 'on',
              tags: String(form.get('tags') ?? '')
                .split(/[,，\s]+/)
                .filter(Boolean),
            });
          }}
        >
          <h3 className="editor-block-title">{t('材质基本信息')}</h3>
          <label className="field-label">
            {t('名称')}
            <input
              className="input"
              name="title"
              maxLength={80}
              defaultValue={item.title}
              disabled={busy}
              autoFocus
            />
          </label>
          <label className="field-label">
            {tf('标签（最多 {max} 个，用空格或逗号分隔）', { max: MAX_TAGS })}
            <input
              className="input"
              name="tags"
              defaultValue={item.tags?.join(' ')}
              maxLength={MAX_TAGS * (MAX_TAG_LENGTH + 1)}
              disabled={busy}
            />
          </label>
          <label className="field-label">
            {t('材质来源')}
            <select
              aria-label={t('材质来源')}
              name="source"
              className="input"
              defaultValue={item.source ?? 'unknown'}
              disabled={busy}
            >
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('许可与署名')}
            <input
              name="license"
              className="input"
              maxLength={MAX_LICENSE_LENGTH}
              defaultValue={item.license}
              disabled={busy}
            />
          </label>
          <div className="actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {t('保存材质信息')}
            </button>
          </div>
        </form>

        {item.kind === 'skin' && (
          <div className="editor-block">
            <h3 className="editor-block-title">{t('站点账号头像')}</h3>
            <div className="editor-avatar-row">
              <img
                className="texture-preview texture-preview--skin"
                src={textureSrc(item)}
                alt={textureTitle(item)}
              />
              <div>
                <p className="section-hint">
                  {t('设为头像后会立即更新全站顶栏显示。')}
                </p>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy}
                  onClick={onSetAvatar}
                >
                  {t('设为站点账号头像')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="editor-block">
          <h3 className="editor-block-title">{t('公共皮肤库发布')}</h3>
          <p className="badge-row">
            <span
              className={`status-pill${item.published === 1 ? ' status-pill--active' : ' status-pill--neutral'}`}
            >
              {item.published === 1 ? t('已公开') : t('未公开')}
            </span>
            {item.state && (
              <span className="status-pill">{STATE_LABELS[item.state]}</span>
            )}
          </p>
          {item.reviewReason && <p className="section-hint">{item.reviewReason}</p>}
          <p className="section-hint">
            {t('公开材质及其修改需经人工审核后展示。')}
          </p>
          <label className="wardrobe-publish">
            <input
              name="published"
              form="texture-metadata"
              type="checkbox"
              defaultChecked={item.published === 1}
              disabled={busy}
            />
            {t('公开到皮肤库')}
          </label>
          <p className="section-hint">
            {t('勾选后请回到「材质基本信息」区块点击保存以提交审核。')}
          </p>
        </div>

        <div className="editor-danger">
          <h3 className="editor-block-title">{t('危险操作')}</h3>
          <button
            className="btn btn--danger"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('从衣柜移除此材质？'))) onRemove();
            }}
          >
            {t('从衣柜移除')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
