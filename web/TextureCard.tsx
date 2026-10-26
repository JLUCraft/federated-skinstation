import React from 'react';
import type { TextureItem } from '../shared/wardrobe';
import {
  Avatar,
  Author,
  TextureProvenance,
  TextureCounts,
  STATE_LABELS,
} from './TextureIdentity';
import { TextureThumb } from './TextureThumb';
import { textureSrc, textureTitle } from './TextureDialog';
import { t, tf } from './i18n';

/** Detail URL for an entry; the share control and the title both point here. */
const detailHref = (item: TextureItem) => `/portal/library/${item.id}`;

/**
 * Shared listing card. Thumbnail and title are the detail targets, the share
 * control sits top-right, and one badge row merges kind, model and source.
 */
export function TextureCard({
  item,
  library,
  onOpen,
  children,
}: {
  item: TextureItem;
  library: boolean;
  onOpen?: () => void;
  children?: React.ReactNode;
}) {
  const [shared, setShared] = React.useState(false);
  const label = tf('查看详情：{title}', { title: textureTitle(item) });
  const href = detailHref(item);
  const body = (
    <>
      <TextureThumb
        url={textureSrc(item)}
        kind={item.kind}
        slim={item.model === 'slim'}
        label={textureTitle(item)}
      />
      <span className="texture-card-title">{textureTitle(item)}</span>
    </>
  );
  return (
    <article
      className={`texture-card${!library && item.applied === 1 ? ' texture-card--active' : ''}`}
    >
      <div className="texture-card-open-wrap">
        {onOpen ? (
          <button
            type="button"
            className="thumb-button"
            aria-label={label}
            onClick={onOpen}
          >
            {body}
          </button>
        ) : (
          <a className="thumb-button" aria-label={label} href={href}>
            {body}
          </a>
        )}
        {library && (
          <button
            type="button"
            className="texture-share"
            aria-label={t('分享材质')}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(new URL(href, window.location.origin).href)
                .then(() => setShared(true))
            }
          >
            <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
      {shared && (
        <p className="section-hint" role="status">
          {t('材质链接已复制')}
        </p>
      )}
      {library ? (
        <Author item={item} />
      ) : (
        item.kind === 'skin' && <Avatar hash={item.hash} />
      )}
      <div className="badge-row">
        <span className="status-pill">
          {item.kind === 'skin' ? t('皮肤') : t('披风')}
        </span>
        {item.kind === 'skin' && item.model === 'slim' && (
          <span className="status-pill status-pill--neutral">{t('纤细')}</span>
        )}
        <TextureProvenance item={item} />
      </div>
      {!library && item.state && (
        <p className="badge-row">
          <span className="status-pill">{STATE_LABELS[item.state]}</span>
          {item.published === 1 && (
            <span className="status-pill status-pill--neutral">
              {t('已公开')}
            </span>
          )}
          {item.applied === 1 && (
            <span className="status-pill status-pill--active">
              {t('正在使用')}
            </span>
          )}
        </p>
      )}
      {!library && item.reviewReason && <p>{item.reviewReason}</p>}
      {library && <TextureCounts item={item} />}
      {children}
    </article>
  );
}
