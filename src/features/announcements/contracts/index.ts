export const ANNOUNCEMENTS_ORIGIN = 'https://agentteams.live';
export const ANNOUNCEMENTS_FEED_PATH = '/announcements/feed.v1.json';
export const ANNOUNCEMENTS_MAX_FEED_BYTES = 512 * 1024;
export const ANNOUNCEMENTS_MAX_BODY_BYTES = 256 * 1024;
export const ANNOUNCEMENTS_MAX_ITEMS = 1000;
export const ANNOUNCEMENTS_CHANNELS = {
  getSnapshot: 'announcements:getSnapshot',
  refresh: 'announcements:refresh',
  prepareAuto: 'announcements:prepareAuto',
  claimAuto: 'announcements:claimAuto',
  openManual: 'announcements:openManual',
  dismiss: 'announcements:dismiss',
  stateChanged: 'announcements:stateChanged',
} as const;

export interface AnnouncementOrderKey {
  publishedAt: string;
  id: string;
}

export interface Announcement extends AnnouncementOrderKey {
  title: string;
  validUntil: string;
  showToNewUsers: boolean;
  minUsageMinutes: number;
  status: 'published' | 'archived';
  bodyPath: string;
  bodySha256: string;
}

export interface AnnouncementFeed {
  schemaVersion: 1;
  revision: string;
  autoShowEnabled: boolean;
  items: Announcement[];
}

export interface AnnouncementDocument {
  announcement: Announcement;
  markdown: string;
  bodyUrl: string;
}

export interface PreparedAnnouncement extends AnnouncementDocument {
  revision: string;
}

export interface AnnouncementState {
  schemaVersion: 1;
  origin: 'fresh' | 'legacy' | 'unknown';
  firstAppOpenedAt: string | null;
  trackingStartedAt: string;
  accumulatedOpenMs: number;
  autoSuppressedThrough: AnnouncementOrderKey | null;
  handledIds: string[];
  dismissedIds: string[];
}

export type AnnouncementsStatus =
  | 'ready'
  | 'disabled'
  | 'offline'
  | 'state_unavailable'
  | 'writer_busy'
  | 'unavailable';

export interface AnnouncementsSnapshot {
  status: AnnouncementsStatus;
  revision: string | null;
  items: Announcement[];
  candidateId: string | null;
  accumulatedOpenMs: number;
  checkedAt: string | null;
  autoShowEnabled: boolean;
}

export interface ClaimAnnouncementInput {
  id: string;
  revision: string;
  bodySha256: string;
}

export interface AnnouncementsApi {
  getSnapshot(): Promise<AnnouncementsSnapshot>;
  refresh(): Promise<AnnouncementsSnapshot>;
  prepareAuto(): Promise<PreparedAnnouncement | null>;
  claimAuto(input: ClaimAnnouncementInput): Promise<AnnouncementDocument | null>;
  openManual(id: string): Promise<AnnouncementDocument | null>;
  dismiss(id: string): Promise<{ saved: boolean }>;
  onStateChanged(listener: (snapshot: AnnouncementsSnapshot) => void): () => void;
}
