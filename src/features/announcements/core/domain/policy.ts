import { ANNOUNCEMENTS_MAX_STATE_IDS } from '../../contracts';

import type {
  Announcement,
  AnnouncementFeed,
  AnnouncementOrderKey,
  AnnouncementState,
} from '../../contracts';

function cappedIds(values: string[], required?: string): string[] {
  const unique = [...new Set(values)];
  if (unique.length <= ANNOUNCEMENTS_MAX_STATE_IDS) return unique;
  const tail = unique.slice(-ANNOUNCEMENTS_MAX_STATE_IDS);
  if (!required || tail.includes(required)) return tail;
  return [...tail.slice(1), required];
}

export function compareAnnouncementOrder(a: AnnouncementOrderKey, b: AnnouncementOrderKey): number {
  const timeDifference = Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
  return timeDifference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function visibleAnnouncements(feed: AnnouncementFeed, nowMs: number): Announcement[] {
  return feed.items
    .filter((item) => Date.parse(item.publishedAt) <= nowMs)
    .sort((a, b) => -compareAnnouncementOrder(a, b));
}

export function announcementCohortAllowed(item: Announcement, state: AnnouncementState): boolean {
  if (item.showToNewUsers) return true;
  const firstKnown = state.origin === 'fresh' ? state.firstAppOpenedAt : state.trackingStartedAt;
  return firstKnown !== null && Date.parse(firstKnown) < Date.parse(item.publishedAt);
}

export function selectAutoAnnouncement(
  feed: AnnouncementFeed,
  state: AnnouncementState,
  nowMs: number
): Announcement | null {
  if (!feed.autoShowEnabled || !Number.isFinite(nowMs)) return null;
  const handled = new Set([...state.handledIds, ...state.dismissedIds]);
  return (
    visibleAnnouncements(feed, nowMs).find(
      (item) =>
        item.status === 'published' &&
        nowMs < Date.parse(item.validUntil) &&
        announcementCohortAllowed(item, state) &&
        state.accumulatedOpenMs >= item.minUsageMinutes * 60_000 &&
        !handled.has(item.id) &&
        (!state.autoSuppressedThrough ||
          compareAnnouncementOrder(item, state.autoSuppressedThrough) > 0)
    ) ?? null
  );
}

export function consumeAnnouncement(
  state: AnnouncementState,
  item: Announcement
): AnnouncementState {
  const key = { id: item.id, publishedAt: item.publishedAt };
  const floor =
    !state.autoSuppressedThrough || compareAnnouncementOrder(key, state.autoSuppressedThrough) > 0
      ? key
      : state.autoSuppressedThrough;
  return {
    ...state,
    handledIds: cappedIds([...state.handledIds, item.id], floor.id),
    autoSuppressedThrough: floor,
  };
}

export function dismissAnnouncement(state: AnnouncementState, id: string): AnnouncementState {
  return { ...state, dismissedIds: cappedIds([...state.dismissedIds, id]) };
}

export function createAnnouncementState(
  origin: AnnouncementState['origin'],
  trackingStartedAt: string,
  firstAppOpenedAt: string | null = null
): AnnouncementState {
  return {
    schemaVersion: 1,
    origin,
    trackingStartedAt,
    firstAppOpenedAt: origin === 'fresh' ? firstAppOpenedAt : null,
    accumulatedOpenMs: 0,
    autoSuppressedThrough: null,
    handledIds: [],
    dismissedIds: [],
  };
}

/** Uses only monotonic timestamps; gaps beyond the heartbeat tolerance earn no time. */
export function countOpenInterval(
  previousMono: number | null,
  nowMono: number,
  active: boolean,
  maxGapMs = 15_000
): { anchor: number | null; elapsedMs: number } {
  if (!active || !Number.isFinite(nowMono)) return { anchor: null, elapsedMs: 0 };
  const delta = previousMono === null ? 0 : nowMono - previousMono;
  return { anchor: nowMono, elapsedMs: delta >= 0 && delta <= maxGapMs ? Math.floor(delta) : 0 };
}
