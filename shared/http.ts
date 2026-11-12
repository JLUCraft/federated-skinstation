import type { GameProfile } from './profiles.js';
import type { Texture, TextureItem } from './wardrobe.js';
import type { Announcement, Notice } from './community.js';

export interface Authentication {
  accessToken: string;
  clientToken: string;
  selectedProfile?: { id: string; name: string };
  availableProfiles: { id: string; name: string }[];
  user?: { id: string; properties: { name: string; value: string }[] };
}

export interface MemberAccount {
  id: string;
  profileId: string;
  name: string;
  school: string;
  verifiedAt: number;
  profiles: (GameProfile & { textures: Texture[] })[];
  textures: Texture[];
  siteAdmin: boolean;
  muaAdmin: boolean;
  avatar: string | null;
}

export interface Capabilities {
  schools: { id: string; emailDomains: string[] }[];
  muaOAuth: boolean;
  muaMember: boolean;
  muaProvider: boolean;
}

export interface TextureList {
  items: TextureItem[];
}
export interface Notifications {
  items: Notice[];
  unread: number;
}
export interface Announcements {
  announcements: Announcement[];
}
export interface Reviews extends TextureList {
  reports: { id: string; item: string; reason: string }[];
}
export interface PublicAuthor extends TextureList {
  id: string;
  name: string;
  school: string;
  avatar?: string;
  saves: number;
}

type WithoutQuery<Path extends string> = Path extends `${infer Route}?${string}` ? Route : Path;
export type GetResponse<Path extends string> =
  WithoutQuery<Path> extends '/api/library' | '/api/wardrobe'
    ? TextureList
    : WithoutQuery<Path> extends '/api/library/tags'
      ? { tags: { tag: string; count: number }[] }
      : WithoutQuery<Path> extends `/api/library/${string}`
        ? TextureItem
        : WithoutQuery<Path> extends `/api/users/${string}`
          ? PublicAuthor
          : WithoutQuery<Path> extends '/api/admin/reviews'
            ? Reviews
            : WithoutQuery<Path> extends '/api/announcements' | '/api/admin/announcements'
              ? Announcements
              : WithoutQuery<Path> extends '/api/notifications'
                ? Notifications
                : unknown;
