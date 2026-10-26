import type { Source, ReviewState } from './community.js';
export const TEXTURE_PAGE_SIZE = 40;

export type TextureKind = 'skin' | 'cape';
/** The fields a viewer needs to render one texture. */
export type Texture = { kind: TextureKind; hash: string; model: string };

/** A wardrobe or federated-library entry as the listing APIs return it. */
export type TextureItem = Texture & {
  submission?: string | null;
  source?: Source;
  license?: string;
  state?: ReviewState;
  reviewReason?: string;
  downloads?: number;
  saves?: number;
  authorId?: string;
  authorName?: string;
  avatar?: string;
  school?: string;
  public?: boolean;
  id: string;
  title: string;
  published?: number;
  applied?: number;
  likes?: number;
  tags?: string[];
  /** Whether the signed-in viewer liked this library entry. */
  liked?: boolean;
  /** Whether the signed-in viewer already has this texture in their wardrobe. */
  owned?: boolean;
};

export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 16;
export const MAX_SEARCH_LENGTH = 64;
export type LibrarySort = 'new' | 'likes' | 'downloads' | 'saves';
