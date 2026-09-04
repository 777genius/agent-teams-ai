import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildOpenCodeHeadOfLineBlockLaneKey,
  describeOpenCodeHeadOfLineBlock,
  noteOpenCodeHeadOfLineBlockDiagnostic,
  OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS,
  OPENCODE_HEAD_OF_LINE_BLOCK_MAX_LANES,
  OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS,
  OpenCodeHeadOfLineBlockTracker,
  openCodeHeadOfLineBlockTracker,
} from '../OpenCodeHeadOfLineBlockNotice';
import { isInformationalOpenCodeRuntimeDeliveryDiagnostic } from '../OpenCodeRuntimeDeliveryDiagnostics';

import type { OpenCodeHeadOfLineBlocker } from '../OpenCodeHeadOfLineBlockNotice';

const BLOCKED_SINCE = '2026-01-01T10:00:00.000Z';
const BLOCKED_SINCE_MS = Date.parse(BLOCKED_SINCE);

function blocker(overrides: Partial<OpenCodeHeadOfLineBlocker> = {}): OpenCodeHeadOfLineBlocker {
  return {
    inboxMessageId: 'launch-prompt:1',
    lastTurnProgressAt: null,
    lastAttemptAt: BLOCKED_SINCE,
    acceptedAt: BLOCKED_SINCE,
    createdAt: BLOCKED_SINCE,
    ...overrides,
  };
}

const LANE = { teamName: 'team', laneId: 'primary', memberName: 'Team-Lead' };

describe('describeOpenCodeHeadOfLineBlock', () => {
  it('reports the blocker, its age in whole minutes and the queue depth', () => {
    const described = describeOpenCodeHeadOfLineBlock({
      blocker: blocker(),
      queuedCount: 11,
      nowMs: BLOCKED_SINCE_MS + 13 * 60_000 + 30_000,
    });

    expect(described.blockedForMs).toBe(13 * 60_000 + 30_000);
    expect(described.critical).toBe(true);
    expect(described.diagnostic).toBe(
      'OpenCode delivery is queued behind launch-prompt:1 ' +
        '(blockedForMin=13 queuedBehind=11 head_of_line_blocked).'
    );
  });

  it('measures the age from the last turn progress, not from acceptance', () => {
    const described = describeOpenCodeHeadOfLineBlock({
      blocker: blocker({ lastTurnProgressAt: '2026-01-01T10:12:00.000Z' }),
      queuedCount: 2,
      nowMs: BLOCKED_SINCE_MS + 13 * 60_000,
    });

    expect(described.blockedForMs).toBe(60_000);
    expect(described.critical).toBe(false);
  });

  it('renders an unknown age rather than a number it does not have', () => {
    const described = describeOpenCodeHeadOfLineBlock({
      blocker: {
        inboxMessageId: 'launch-prompt:1',
        lastTurnProgressAt: null,
        lastAttemptAt: null,
        acceptedAt: null,
        createdAt: '',
      },
      queuedCount: 1,
      nowMs: BLOCKED_SINCE_MS,
    });

    expect(described.blockedForMs).toBeNull();
    expect(described.critical).toBe(false);
    expect(described.diagnostic).toContain('blockedForMin=unknown');
  });

  // NEGATIVE CONTROL: a lane blocked for less than the critical window is busy,
  // not stuck. It carries no marker, and the diagnostic stays informational -
  // queueing behind the record that holds the lane is how a lane is supposed to
  // work, and reporting every one of those refusals as a fault would bury the
  // one lane that really is wedged.
  it('does not raise the level of a lane that has been blocked for less than the critical window', () => {
    const busy = describeOpenCodeHeadOfLineBlock({
      blocker: blocker(),
      queuedCount: 3,
      nowMs: BLOCKED_SINCE_MS + OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS - 1,
    });

    expect(busy.critical).toBe(false);
    expect(busy.diagnostic).not.toContain('head_of_line_blocked');
    expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(busy.diagnostic)).toBe(true);

    const stuck = describeOpenCodeHeadOfLineBlock({
      blocker: blocker(),
      queuedCount: 3,
      nowMs: BLOCKED_SINCE_MS + OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS,
    });

    expect(stuck.critical).toBe(true);
    expect(stuck.diagnostic).toContain('head_of_line_blocked');
    expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(stuck.diagnostic)).toBe(false);
  });
});

describe('OpenCodeHeadOfLineBlockTracker', () => {
  const laneKey = buildOpenCodeHeadOfLineBlockLaneKey(LANE);

  it('counts each further message queued behind the same blocker', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();

    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' })).toBe(1);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' })).toBe(2);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'c' })).toBe(3);
  });

  // NEGATIVE CONTROL: the depth is a count of DISTINCT messages. A blocked lane
  // is re-woken every observe cycle, so the same message is refused over and
  // over; counting refusals instead of messages would turn one waiting message
  // into a queue of dozens within a minute.
  it('does not inflate the depth when one message retries against the same blocker', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();

    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' })).toBe(1);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' })).toBe(1);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' })).toBe(1);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' })).toBe(2);
  });

  // NEGATIVE CONTROL: a different blocker is a different jam, so its depth
  // starts over. Carrying the previous count forward would report a lane that
  // is moving as one that never moved.
  it('restarts the count when a new blocker takes the lane', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();

    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' });
    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' });

    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:2', queuedMessageId: 'c' })).toBe(1);
    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:2', queuedMessageId: 'd' })).toBe(2);
  });

  it('keeps the lanes apart', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();
    const otherLane = buildOpenCodeHeadOfLineBlockLaneKey({ ...LANE, laneId: 'secondary' });

    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' });
    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' });

    expect(
      tracker.note({ laneKey: otherLane, blockerMessageId: 'blocker:1', queuedMessageId: 'a' })
    ).toBe(1);
  });

  it('folds the member name case into one lane key', () => {
    expect(buildOpenCodeHeadOfLineBlockLaneKey({ ...LANE, memberName: '  team-lead  ' })).toBe(
      laneKey
    );
  });

  // NEGATIVE CONTROL: the tracker is a singleton in a process that outlives
  // every run, and each run mints fresh lane ids, so the map is bounded. An
  // evicted lane must simply start counting again rather than resurrect a count
  // for a blocker the tracker no longer remembers.
  it('starts a lane evicted by the bound again at one', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();
    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' });
    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' });

    // The oldest lane is the one under test, so filling the bound evicts it.
    for (let lane = 0; lane < OPENCODE_HEAD_OF_LINE_BLOCK_MAX_LANES; lane += 1) {
      tracker.note({
        laneKey: `filler::${lane}`,
        blockerMessageId: 'blocker:1',
        queuedMessageId: 'a',
      });
    }

    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'c' })).toBe(1);
  });

  it('stops growing one lane at the queued-id bound and reports the depth as a lower bound', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();

    for (let queued = 0; queued < OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS; queued += 1) {
      tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: `msg:${queued}` });
    }

    // A blocker that never terminalises keeps taking new ids for as long as the
    // inbox produces them, so the set - not just the number of lanes - has to
    // be bounded.
    expect(
      tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'overflow:1' })
    ).toBe(OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS);
    expect(
      tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'overflow:2' })
    ).toBe(OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS);

    expect(
      describeOpenCodeHeadOfLineBlock({
        blocker: blocker(),
        queuedCount: OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS,
        nowMs: BLOCKED_SINCE_MS,
      }).diagnostic
    ).toContain(`queuedBehind=${OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS}+)`);
  });

  // NEGATIVE CONTROL: the bound must not turn every depth into a lower bound.
  // A lane below the cap still reports an exact count, which is the number that
  // separates a lane with one message waiting from a lane with a dozen.
  it('reports an exact depth below the queued-id bound', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();

    for (let queued = 0; queued < OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS - 1; queued += 1) {
      tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: `msg:${queued}` });
    }

    expect(
      tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'msg:last' })
    ).toBe(OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS);
    expect(
      describeOpenCodeHeadOfLineBlock({
        blocker: blocker(),
        queuedCount: OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS - 1,
        nowMs: BLOCKED_SINCE_MS,
      }).diagnostic
    ).toContain(`queuedBehind=${OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS - 1})`);
  });

  it('holds a lane that is still inside the bound', () => {
    const tracker = new OpenCodeHeadOfLineBlockTracker();
    tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'a' });

    for (let lane = 0; lane < OPENCODE_HEAD_OF_LINE_BLOCK_MAX_LANES - 1; lane += 1) {
      tracker.note({
        laneKey: `filler::${lane}`,
        blockerMessageId: 'blocker:1',
        queuedMessageId: 'a',
      });
    }

    expect(tracker.note({ laneKey, blockerMessageId: 'blocker:1', queuedMessageId: 'b' })).toBe(2);
  });
});

describe('noteOpenCodeHeadOfLineBlockDiagnostic', () => {
  beforeEach(() => {
    openCodeHeadOfLineBlockTracker.clear();
  });

  it('counts the refusal and renders the line the delivery service returns', () => {
    const first = noteOpenCodeHeadOfLineBlockDiagnostic({
      ...LANE,
      blocker: blocker(),
      queuedMessageId: 'notice:1',
      nowMs: BLOCKED_SINCE_MS + 6 * 60_000,
    });
    const second = noteOpenCodeHeadOfLineBlockDiagnostic({
      ...LANE,
      blocker: blocker(),
      queuedMessageId: 'notice:2',
      nowMs: BLOCKED_SINCE_MS + 6 * 60_000,
    });

    expect(first).toBe(
      'OpenCode delivery is queued behind launch-prompt:1 ' +
        '(blockedForMin=6 queuedBehind=1 head_of_line_blocked).'
    );
    expect(second).toContain('queuedBehind=2');
  });

  it('counts every message with no id as the same anonymous slot', () => {
    noteOpenCodeHeadOfLineBlockDiagnostic({
      ...LANE,
      blocker: blocker(),
      queuedMessageId: undefined,
      nowMs: BLOCKED_SINCE_MS,
    });
    const second = noteOpenCodeHeadOfLineBlockDiagnostic({
      ...LANE,
      blocker: blocker(),
      queuedMessageId: undefined,
      nowMs: BLOCKED_SINCE_MS,
    });

    expect(second).toContain('queuedBehind=1');
  });
});
