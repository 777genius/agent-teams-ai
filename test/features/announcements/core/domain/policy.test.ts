import { describe, expect, it } from 'vitest';

import { ANNOUNCEMENTS_MAX_STATE_IDS } from '../../../../../src/features/announcements/contracts';
import {
  consumeAnnouncement,
  countOpenInterval,
  createAnnouncementState,
  dismissAnnouncement,
  normalizeAnnouncement,
  normalizeAnnouncementDate,
  normalizeAnnouncementFeed,
  normalizeAnnouncementState,
  selectAutoAnnouncement,
  visibleAnnouncements,
} from '../../../../../src/features/announcements/core/domain';

const hash = 'a'.repeat(64);
const now = Date.parse('2026-09-04T12:00:00Z');
const item = (id = 'hello', extra = {}) => ({
  id,
  title: ' News ',
  publishedAt: '2026-09-01T12:00:00Z',
  status: 'published',
  bodyPath: `/announcements/content/${id}/${hash}/body.md`,
  bodySha256: hash,
  ...extra,
});
const feed = (...items: unknown[]) =>
  normalizeAnnouncementFeed({
    schemaVersion: 1,
    revision: hash,
    autoShowEnabled: true,
    items,
  });
const state = () => ({
  ...createAnnouncementState('fresh', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  accumulatedOpenMs: 30 * 60_000,
});

describe('strict feed and state boundaries', () => {
  it('does not invent a first-open date for preexisting profiles', () => {
    expect(
      createAnnouncementState('legacy', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
        .firstAppOpenedAt
    ).toBeNull();
  });
  it('normalizes dates and explicit falsy defaults', () => {
    expect(
      normalizeAnnouncement(item('hello', { showToNewUsers: false, minUsageMinutes: 0 }))
    ).toMatchObject({
      showToNewUsers: false,
      minUsageMinutes: 0,
      title: 'News',
      validUntil: '2026-09-15T12:00:00.000Z',
    });
    expect(normalizeAnnouncementDate('2026-09-04T14:00:00+02:00')).toBe('2026-09-04T12:00:00.000Z');
  });
  it('accepts an optional hero image only from the article bundle', () => {
    const value = item('hello');
    const bundleRoot = value.bodyPath.slice(0, -'body.md'.length);
    expect(
      normalizeAnnouncement({ ...value, heroImagePath: `${bundleRoot}assets/hero.png` })
        .heroImagePath
    ).toBe(`${bundleRoot}assets/hero.png`);
    for (const heroImagePath of [
      null,
      '/announcements/content/hello/other/assets/hero.png',
      `${bundleRoot}assets/../hero.png`,
      `${bundleRoot}assets/hero.svg`,
      'https://agentteams.live/announcements/content/hello/assets/hero.png',
    ])
      expect(() => normalizeAnnouncement({ ...value, heroImagePath })).toThrow('heroImagePath');
  });
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-09-01',
    '2026-09-01T12:00:00',
    '2026-09-01T24:00:00Z',
    '2026-09-01T12:00:00+24:00',
    null,
  ])('rejects invalid date %s', (date) => {
    expect(() => normalizeAnnouncementDate(date)).toThrow();
  });
  it.each([
    { validUntil: null },
    { minUsageMinutes: null },
    { showToNewUsers: null },
    { validUntil: '' },
    { minUsageMinutes: -1 },
    { minUsageMinutes: 0.5 },
    { minUsageMinutes: Number.MAX_SAFE_INTEGER },
    { status: 'withdrawn' },
    { id: '__proto__' },
    { bodyPath: 'https://attacker.test/body.md' },
    { bodyPath: `/announcements/content/hello/${hash}/../body.md` },
  ])('rejects whole feed with bad item %j', (extra) => {
    expect(() => feed(item('valid'), item('hello', extra))).toThrow();
  });
  it('rejects duplicate IDs but ignores unknown v1 fields', () => {
    expect(() => feed(item(), item())).toThrow();
    expect(feed(item('hello', { harmlessExtra: true })).items).toHaveLength(1);
  });
  it('does not coerce corrupt state to fresh empty history', () => {
    expect(() => normalizeAnnouncementState({ ...state(), handledIds: null })).toThrow();
    expect(() => normalizeAnnouncementState({ ...state(), accumulatedOpenMs: -1 })).toThrow();
    expect(() => normalizeAnnouncementState({ ...state(), origin: 'legacy' })).toThrow();
    expect(normalizeAnnouncementState(state()).handledIds).toEqual([]);
  });
  it('rejects a missing floor instead of replaying older news after restart', () => {
    const f = feed(item('old'), item('latest', { publishedAt: '2026-09-02T00:00:00Z' }));
    const consumed = consumeAnnouncement(state(), selectAutoAnnouncement(f, state(), now)!);
    const persisted = normalizeAnnouncementState(JSON.parse(JSON.stringify(consumed)));
    expect(selectAutoAnnouncement(f, persisted, now)).toBeNull();
    expect(() => normalizeAnnouncementState({ ...persisted, autoSuppressedThrough: null })).toThrow(
      'missing floor'
    );
  });
  it('rejects a floor whose atomic consumption history was lost', () => {
    const consumed = consumeAnnouncement(state(), normalizeAnnouncement(item('latest')));
    expect(() => normalizeAnnouncementState({ ...consumed, handledIds: [] })).toThrow(
      'unhandled floor'
    );
    expect(() => normalizeAnnouncementState({ ...consumed, handledIds: ['other'] })).toThrow(
      'unhandled floor'
    );
  });
  it('rejects persisted fresh profiles missing their first open date', () => {
    expect(() => normalizeAnnouncementState({ ...state(), firstAppOpenedAt: null })).toThrow(
      'fresh cohort date'
    );
  });
  it('bounds persisted identifier cardinality', () => {
    const handledIds = Array.from(
      { length: ANNOUNCEMENTS_MAX_STATE_IDS + 1 },
      (_, index) => `news-${index}`
    );
    expect(() =>
      normalizeAnnouncementState({
        ...state(),
        handledIds,
        autoSuppressedThrough: {
          id: handledIds.at(-1),
          publishedAt: '2026-09-01T00:00:00Z',
        },
      })
    ).toThrow('too many state ids');
  });
});

describe('selection and durable suppression policy', () => {
  it('uses binary ID order independent of feed order', () => {
    expect(selectAutoAnnouncement(feed(item('a'), item('z')), state(), now)?.id).toBe('z');
    expect(selectAutoAnnouncement(feed(item('z'), item('a')), state(), now)?.id).toBe('z');
  });
  it('suppresses delayed old items even after newer item withdrawal', () => {
    const old = item('old', { minUsageMinutes: 60 });
    const newest = normalizeAnnouncement(item('new', { publishedAt: '2026-09-02T00:00:00Z' }));
    const consumed = consumeAnnouncement(state(), newest);
    expect(
      selectAutoAnnouncement(feed(old), { ...consumed, accumulatedOpenMs: 60 * 60_000 }, now)
    ).toBeNull();
  });
  it('allows old lower usage candidate then genuinely newer one', () => {
    const f = feed(
      item('old'),
      item('new', { publishedAt: '2026-09-02T00:00:00Z', minUsageMinutes: 60 })
    );
    const first = selectAutoAnnouncement(f, state(), now)!;
    expect(first.id).toBe('old');
    expect(
      selectAutoAnnouncement(
        f,
        { ...consumeAnnouncement(state(), first), accumulatedOpenMs: 60 * 60_000 },
        now
      )?.id
    ).toBe('new');
  });
  it('keeps ID consumed after date/body edits and never moves floor backwards', () => {
    const first = normalizeAnnouncement(item('hello'));
    const handled = consumeAnnouncement(state(), first);
    const back = consumeAnnouncement(
      handled,
      normalizeAnnouncement(item('older', { publishedAt: '2026-08-31T00:00:00Z' }))
    );
    expect(back.autoSuppressedThrough).toEqual(handled.autoSuppressedThrough);
    expect(
      selectAutoAnnouncement(
        feed(item('hello', { publishedAt: '2026-09-03T00:00:00Z' })),
        handled,
        now
      )
    ).toBeNull();
    expect(
      dismissAnnouncement(dismissAnnouncement(handled, 'hello'), 'hello').dismissedIds
    ).toEqual(['hello']);
  });
  it('includes expired/archived history but excludes future without advancing floor', () => {
    const f = feed(
      item('expired', { validUntil: '2026-09-02T00:00:00Z' }),
      item('archived', { status: 'archived' }),
      item('future', { publishedAt: '2026-09-05T00:00:00Z' })
    );
    expect(visibleAnnouncements(f, now).map((x) => x.id)).toEqual(['expired', 'archived']);
    expect(selectAutoAnnouncement(f, state(), now)).toBeNull();
    expect(
      selectAutoAnnouncement(
        feed(item('boundary', { validUntil: new Date(now).toISOString() })),
        state(),
        now
      )
    ).toBeNull();
  });
  it.each(['legacy', 'unknown'] as const)(
    'conservatively fixes %s cohort across usage growth',
    (origin) => {
      const s = {
        ...createAnnouncementState(origin, '2026-09-02T00:00:00Z'),
        accumulatedOpenMs: 1e9,
      };
      expect(
        selectAutoAnnouncement(feed(item('old', { showToNewUsers: false })), s, now)
      ).toBeNull();
      expect(
        selectAutoAnnouncement(
          feed(item('new', { showToNewUsers: false, publishedAt: '2026-09-03T00:00:00Z' })),
          s,
          now
        )?.id
      ).toBe('new');
    }
  );
  it('fresh cohort equality is new, and kill switch stops selection', () => {
    const s = { ...state(), firstAppOpenedAt: '2026-09-01T12:00:00Z' };
    expect(
      selectAutoAnnouncement(feed(item('hello', { showToNewUsers: false })), s, now)
    ).toBeNull();
    expect(selectAutoAnnouncement({ ...feed(item()), autoShowEnabled: false }, s, now)).toBeNull();
  });
});

describe('monotonic accounting', () => {
  it('counts ordinary tick and drops unexplained gap, backwards clock, and sleep', () => {
    expect(countOpenInterval(0, 5000, true)).toEqual({ anchor: 5000, elapsedMs: 5000 });
    expect(countOpenInterval(0, 15001, true)).toEqual({ anchor: 15001, elapsedMs: 0 });
    expect(countOpenInterval(5000, 0, true).elapsedMs).toBe(0);
    expect(countOpenInterval(0, 5000, false)).toEqual({ anchor: null, elapsedMs: 0 });
    expect(countOpenInterval(null, 100000, true).elapsedMs).toBe(0);
  });
});

describe('shared persisted state bound', () => {
  it('round-trips maximum-cardinality long IDs within 512KiB', () => {
    const ids = Array.from(
      { length: ANNOUNCEMENTS_MAX_STATE_IDS },
      (_, index) => `a${index.toString().padStart(4, '0')}${'x'.repeat(74)}`
    );
    const normalized = normalizeAnnouncementState({ ...state(), dismissedIds: ids });
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength).toBeLessThanOrEqual(
      512 * 1024
    );
    expect(normalizeAnnouncementState(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
  });

  it('applies the ID cardinality as a shared total', () => {
    const handledIds = ['handled'];
    const dismissedIds = Array.from(
      { length: ANNOUNCEMENTS_MAX_STATE_IDS },
      (_, index) => `d${index.toString().padStart(4, '0')}`
    );
    expect(() =>
      normalizeAnnouncementState({
        ...state(),
        handledIds,
        dismissedIds,
        autoSuppressedThrough: { id: 'handled', publishedAt: '2026-01-01T00:00:00Z' },
      })
    ).toThrow('too many state ids');
  });
});

it('keeps long-running consume and dismiss transitions within the shared writable bound', () => {
  let current = state();
  for (let index = 0; index < ANNOUNCEMENTS_MAX_STATE_IDS + 200; index++) {
    const id = `announcement-${index}`;
    const announcement = normalizeAnnouncement(
      item(id, {
        publishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 1000).toISOString(),
      })
    );
    current = consumeAnnouncement(current, announcement);
    current = dismissAnnouncement(current, id);
    current = normalizeAnnouncementState(current);
  }
  expect(current.handledIds).toEqual([current.autoSuppressedThrough!.id]);
  expect(current.handledIds.length + current.dismissedIds.length).toBeLessThanOrEqual(
    ANNOUNCEMENTS_MAX_STATE_IDS
  );
  expect(normalizeAnnouncementState(JSON.parse(JSON.stringify(current)))).toEqual(current);
});

it('keeps dismissal writable when handled history already consumes the full bound', () => {
  const handledIds = Array.from(
    { length: ANNOUNCEMENTS_MAX_STATE_IDS },
    (_, index) => `handled-${index}`
  );
  const full = {
    ...state(),
    handledIds,
    autoSuppressedThrough: { id: handledIds.at(-1)!, publishedAt: '2026-01-01T00:00:00Z' },
  };
  const dismissed = dismissAnnouncement(full, handledIds.at(-1)!);
  expect(dismissed.dismissedIds).toEqual([]);
  const normalized = normalizeAnnouncementState(dismissed);
  expect(normalizeAnnouncementState(normalized)).toEqual(normalized);
});
