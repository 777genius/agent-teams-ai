import type { Announcement, AnnouncementFeed, AnnouncementState } from '../../contracts';

export interface AnnouncementClock {
  now(): number;
  monotonic(): number;
}
export interface AnnouncementRepository {
  initialize(initial: AnnouncementState): Promise<AnnouncementState>;
  update(change: (current: AnnouncementState) => AnnouncementState): Promise<AnnouncementState>;
  drain(): Promise<void>;
}
export interface AnnouncementSource {
  loadCached(): Promise<void>;
  refresh(signal: AbortSignal): Promise<AnnouncementFeed>;
  body(item: Announcement, signal: AbortSignal): Promise<{ markdown: string; bodyUrl: string }>;
  asset(url: string, signal: AbortSignal): Promise<string>;
  current(): AnnouncementFeed | null;
  drain(): Promise<void>;
}
export interface AnnouncementOwner {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}
export interface AnnouncementWindowContext {
  windowId: number;
  uiGeneration: number;
  isReady(): boolean;
}
