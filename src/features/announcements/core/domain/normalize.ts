import { ANNOUNCEMENTS_MAX_ITEMS, ANNOUNCEMENTS_MAX_STATE_IDS } from '../../contracts';

import type { Announcement, AnnouncementFeed, AnnouncementState } from '../../contracts';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function invalid(field: string): never {
  throw new Error(`Invalid announcements ${field}`);
}

function object(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(field);
  return input as Record<string, unknown>;
}

export function isAnnouncementId(input: unknown): input is string {
  return typeof input === 'string' && ID_PATTERN.test(input);
}

export function normalizeAnnouncementDate(input: unknown): string {
  if (typeof input !== 'string') return invalid('date');
  const match = DATE_PATTERN.exec(input);
  if (!match) return invalid('date');
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return invalid('date');
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) {
    return invalid('timezone');
  }
  const time = Date.parse(input);
  if (!Number.isFinite(time)) return invalid('date');
  return new Date(time).toISOString();
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) return invalid(field);
  return input;
}

export function normalizeAnnouncement(input: unknown): Announcement {
  const item = object(input, 'item');
  if (!isAnnouncementId(item.id)) return invalid('id');
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 200) {
    return invalid('title');
  }
  const publishedAt = normalizeAnnouncementDate(item.publishedAt);
  const validUntil = Object.hasOwn(item, 'validUntil')
    ? normalizeAnnouncementDate(item.validUntil)
    : new Date(Date.parse(publishedAt) + 14 * 24 * 60 * 60 * 1000).toISOString();
  if (Date.parse(validUntil) <= Date.parse(publishedAt)) return invalid('validUntil');
  const showToNewUsers = Object.hasOwn(item, 'showToNewUsers') ? item.showToNewUsers : true;
  if (typeof showToNewUsers !== 'boolean') return invalid('showToNewUsers');
  const minUsageMinutes = nonnegativeInteger(
    Object.hasOwn(item, 'minUsageMinutes') ? item.minUsageMinutes : 30,
    'minUsageMinutes'
  );
  if (!Number.isSafeInteger(minUsageMinutes * 60_000)) return invalid('minUsageMinutes');
  if (item.status !== 'published' && item.status !== 'archived') return invalid('status');
  if (typeof item.bodySha256 !== 'string' || !HASH_PATTERN.test(item.bodySha256))
    return invalid('bodySha256');
  if (
    typeof item.bodyPath !== 'string' ||
    !new RegExp(`^/announcements/content/${item.id}/[a-f0-9]{64}/body\\.md$`).test(item.bodyPath)
  ) {
    return invalid('bodyPath');
  }
  return {
    id: item.id,
    title: item.title.trim(),
    publishedAt,
    validUntil,
    showToNewUsers,
    minUsageMinutes,
    status: item.status,
    bodyPath: item.bodyPath,
    bodySha256: item.bodySha256,
  };
}

export function normalizeAnnouncementFeed(input: unknown): AnnouncementFeed {
  const feed = object(input, 'feed');
  if (feed.schemaVersion !== 1) return invalid('schemaVersion');
  if (typeof feed.revision !== 'string' || !HASH_PATTERN.test(feed.revision))
    return invalid('revision');
  if (typeof feed.autoShowEnabled !== 'boolean') return invalid('autoShowEnabled');
  if (!Array.isArray(feed.items) || feed.items.length > ANNOUNCEMENTS_MAX_ITEMS)
    return invalid('items');
  const items = feed.items.map(normalizeAnnouncement);
  if (new Set(items.map((item) => item.id)).size !== items.length) return invalid('duplicate id');
  return {
    schemaVersion: 1,
    revision: feed.revision,
    autoShowEnabled: feed.autoShowEnabled,
    items,
  };
}

function ids(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every(isAnnouncementId)) return invalid('state ids');
  if (input.length > ANNOUNCEMENTS_MAX_STATE_IDS) return invalid('too many state ids');
  if (new Set(input).size !== input.length) return invalid('duplicate state ids');
  return [...input] as string[];
}

export function normalizeAnnouncementState(input: unknown): AnnouncementState {
  const state = object(input, 'state');
  if (state.schemaVersion !== 1) return invalid('state schemaVersion');
  if (state.origin !== 'fresh' && state.origin !== 'legacy' && state.origin !== 'unknown')
    return invalid('origin');
  const trackingStartedAt = normalizeAnnouncementDate(state.trackingStartedAt);
  const firstAppOpenedAt =
    state.firstAppOpenedAt === null ? null : normalizeAnnouncementDate(state.firstAppOpenedAt);
  if (state.origin !== 'fresh' && firstAppOpenedAt !== null) return invalid('cohort');
  if (state.origin === 'fresh' && firstAppOpenedAt === null) return invalid('fresh cohort date');
  let autoSuppressedThrough = null;
  if (state.autoSuppressedThrough !== null) {
    const floor = object(state.autoSuppressedThrough, 'floor');
    if (!isAnnouncementId(floor.id)) return invalid('floor id');
    autoSuppressedThrough = {
      id: floor.id,
      publishedAt: normalizeAnnouncementDate(floor.publishedAt),
    };
  }
  const handledIds = ids(state.handledIds);
  if (handledIds.length > 0 && autoSuppressedThrough === null) return invalid('missing floor');
  if (autoSuppressedThrough !== null && !handledIds.includes(autoSuppressedThrough.id)) {
    return invalid('unhandled floor');
  }
  return {
    schemaVersion: 1,
    origin: state.origin,
    firstAppOpenedAt,
    trackingStartedAt,
    accumulatedOpenMs: nonnegativeInteger(state.accumulatedOpenMs, 'accumulatedOpenMs'),
    autoSuppressedThrough,
    handledIds,
    dismissedIds: ids(state.dismissedIds),
  };
}
