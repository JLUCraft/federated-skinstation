export const MAX_LIST_OFFSET = 10_000;
export const MAX_LICENSE_LENGTH = 500;
export const MAX_REVIEW_REASON_LENGTH = 1000;
export const MAX_ANNOUNCEMENT_TITLE_LENGTH = 120;
export const MAX_ANNOUNCEMENT_CONTENT_LENGTH = 8000;
export const MAX_ANNOUNCEMENT_PRIORITY = 100;
export const SOURCES = ['unknown', 'original', 'derivative', 'repost'] as const;
export type Source = (typeof SOURCES)[number];
export const REVIEW_STATES = ['pending', 'approved', 'rejected'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const SEVERITIES = ['info', 'warning', 'danger'] as const;
export type Announcement = {
  id: string;
  title: string;
  content: string;
  severity: (typeof SEVERITIES)[number];
  priority: number;
  expand: number;
  published_at: number;
};
export type Notice = {
  state: ReviewState | null;
  id: string;
  kind: 'like' | 'save' | 'review';
  item: string | null;
  title: string;
  detail: string;
  created_at: number;
  read_at: number | null;
  /** Texture behind the notice, when it still exists, so rows can show and link it. */
  hash?: string | null;
  item_kind?: 'skin' | 'cape' | null;
  item_title?: string | null;
};
