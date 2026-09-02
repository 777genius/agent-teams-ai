import { describe, expect, it, vi } from 'vitest';

import {
  decidePrimaryLaneBootstrapSelfHeal,
  describePrimaryLaneBootstrapSelfHeal,
  OpenCodePrimaryLaneBootstrapSelfHealTracker,
  PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC,
  PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC,
  PRIMARY_LANE_REBOOTSTRAP_GRACE_WINDOW_DIAGNOSTIC,
  PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN,
  PRIMARY_LANE_REBOOTSTRAP_RATE_LIMITED_DIAGNOSTIC,
  PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS,
} from '../OpenCodePrimaryLaneBootstrapSelfHeal';

import type { OpenCodePrimaryLaneBootstrapSelfHealPorts } from '../OpenCodePrimaryLaneBootstrapSelfHeal';
import type { Mock } from 'vitest';

const T0 = 1_700_000_000_000;

/** A failed lane directory: it exists and holds only the delivery ledger. */
const UNBOOTSTRAPPED_LANE_STORAGE = {
  laneDirectoryExists: true,
  hasStateOnDisk: true,
  hasRuntimeEvidenceOnDisk: false,
};

const COMMITTED_LANE_STORAGE = {
  laneDirectoryExists: true,
  hasStateOnDisk: true,
  hasRuntimeEvidenceOnDisk: true,
};

describe('decidePrimaryLaneBootstrapSelfHeal', () => {
  it('waits on the first observation so a healthy commit race resolves itself', () => {
    expect(
      decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: T0,
        nowMs: T0,
        attemptsForRun: 0,
        lastAttemptAtMs: null,
      })
    ).toEqual({
      action: 'wait',
      retryAfterMs: PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS,
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_GRACE_WINDOW_DIAGNOSTIC,
    });
  });

  it('never escalates while the lane evidence is on disk', () => {
    const decision = decidePrimaryLaneBootstrapSelfHeal({
      firstMissingObservedAtMs: T0 - 10 * 60_000,
      nowMs: T0,
      attemptsForRun: 0,
      lastAttemptAtMs: null,
      laneIsUnbootstrapped: false,
    });
    // Not merely "wait": the caller must fall through and deliver as before.
    expect(decision.action).toBe('not_applicable');
  });

  it('re-bootstraps once the grace window has passed', () => {
    expect(
      decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: T0,
        nowMs: T0 + 21_000,
        attemptsForRun: 0,
        lastAttemptAtMs: null,
      })
    ).toEqual({ action: 'rebootstrap', attempt: 1, retryAfterMs: 15_000 });
  });

  it('rate limits a second attempt inside the minimum interval', () => {
    const decision = decidePrimaryLaneBootstrapSelfHeal({
      firstMissingObservedAtMs: T0,
      nowMs: T0 + 26_000,
      attemptsForRun: 1,
      lastAttemptAtMs: T0 + 21_000,
    });
    expect(decision).toEqual({
      action: 'wait',
      retryAfterMs: PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS,
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_RATE_LIMITED_DIAGNOSTIC,
    });
  });

  it('allows the second attempt once the interval elapsed', () => {
    expect(
      decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: T0,
        nowMs: T0 + 86_000,
        attemptsForRun: 1,
        lastAttemptAtMs: T0 + 21_000,
      })
    ).toEqual({ action: 'rebootstrap', attempt: 2, retryAfterMs: 15_000 });
  });

  it('gives up after the per-run budget', () => {
    expect(
      decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: T0,
        nowMs: T0 + 200_000,
        attemptsForRun: PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN,
        lastAttemptAtMs: T0 + 86_000,
      })
    ).toEqual({
      action: 'give_up',
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC,
    });
  });

  /**
   * Negative control for the opt-out: with the ladder switched off the decision
   * is terminal, never a relaunch and never an open-ended wait.
   */
  it('gives up immediately, naming the switch, when the self-heal is disabled', () => {
    const decision = decidePrimaryLaneBootstrapSelfHeal({
      firstMissingObservedAtMs: T0,
      nowMs: T0 + 200_000,
      attemptsForRun: 0,
      lastAttemptAtMs: null,
      selfHealEnabled: false,
    });

    expect(decision).toEqual({
      action: 'give_up',
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC,
    });
    expect(describePrimaryLaneBootstrapSelfHeal({ memberName: 'team-lead', decision })).toContain(
      'disabled'
    );
  });

  /**
   * The opt-out must not turn a healthy lane into a terminal delivery: evidence
   * on disk still means "fall through and deliver as before".
   */
  it('still falls through for a committed lane when the self-heal is disabled', () => {
    expect(
      decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: T0,
        nowMs: T0 + 200_000,
        attemptsForRun: 0,
        lastAttemptAtMs: null,
        laneIsUnbootstrapped: false,
        selfHealEnabled: false,
      }).action
    ).toBe('not_applicable');
  });
});

describe('OpenCodePrimaryLaneBootstrapSelfHealTracker', () => {
  function createTracker(nowMs: () => number): {
    tracker: OpenCodePrimaryLaneBootstrapSelfHealTracker;
    rebootstrapPrimaryLane: Mock<
      OpenCodePrimaryLaneBootstrapSelfHealPorts['rebootstrapPrimaryLane']
    >;
  } {
    const rebootstrapPrimaryLane = vi.fn<
      OpenCodePrimaryLaneBootstrapSelfHealPorts['rebootstrapPrimaryLane']
    >(async () => true);
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs,
      inspectLaneStorage: async () => UNBOOTSTRAPPED_LANE_STORAGE,
      rebootstrapPrimaryLane,
    });
    return { tracker, rebootstrapPrimaryLane };
  }

  const request = {
    teamName: 'lane-team',
    laneId: 'primary',
    memberName: 'team-lead',
    runId: 'run-a1',
    reason: 'opencode_primary_lane_bootstrap_missing',
  };

  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  };

  it('waits inside the grace window and re-bootstraps exactly once after it', async () => {
    let now = T0;
    const { tracker, rebootstrapPrimaryLane } = createTracker(() => now);

    expect((await tracker.request(request)).action).toBe('wait');
    expect(rebootstrapPrimaryLane).not.toHaveBeenCalled();

    now = T0 + 21_000;
    expect(await tracker.request(request)).toEqual({
      action: 'rebootstrap',
      attempt: 1,
      retryAfterMs: 15_000,
    });
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent deliveries into one re-bootstrap', async () => {
    let now = T0;
    let release: () => void = () => undefined;
    const rebootstrapPrimaryLane = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
    );
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs: () => now,
      inspectLaneStorage: async () => UNBOOTSTRAPPED_LANE_STORAGE,
      rebootstrapPrimaryLane,
    });

    await tracker.request(request);
    now = T0 + 21_000;
    const [first, second] = await Promise.all([tracker.request(request), tracker.request(request)]);
    const decisions = [first, second].map((decision) => decision.action);

    expect(decisions.filter((action) => action === 'rebootstrap')).toHaveLength(1);
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(1);
    release();
  });

  /**
   * Negative control for the ladder bound: the relaunch port is called exactly
   * `PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN` times for one run and the
   * next request is terminal, with no further relaunch ever scheduled.
   */
  it('spends the bound and then refuses to schedule anything further', async () => {
    let now = T0;
    const { tracker, rebootstrapPrimaryLane } = createTracker(() => now);

    await tracker.request(request);
    for (let attempt = 0; attempt < PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN; attempt += 1) {
      now = T0 + 21_000 + attempt * 65_000;
      expect((await tracker.request(request)).action).toBe('rebootstrap');
      await settle();
    }
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(
      PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN
    );

    for (const laterMs of [200_000, 400_000, 900_000]) {
      now = T0 + laterMs;
      expect((await tracker.request(request)).action).toBe('give_up');
    }
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(
      PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN
    );
  });

  it('keys the budget by run so a fresh launch starts clean', async () => {
    let now = T0;
    const { tracker, rebootstrapPrimaryLane } = createTracker(() => now);

    await tracker.request(request);
    now = T0 + 21_000;
    await tracker.request(request);
    await settle();
    now = T0 + 86_000;
    await tracker.request(request);
    await settle();
    now = T0 + 200_000;
    expect((await tracker.request(request)).action).toBe('give_up');

    const freshRun = { ...request, runId: 'run-a2' };
    expect((await tracker.request(freshRun)).action).toBe('wait');
    now = T0 + 221_000;
    expect((await tracker.request(freshRun)).action).toBe('rebootstrap');
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(3);
  });

  /**
   * Negative control: a lane that already committed its session must never be
   * "healed". This is the control against relaunching a working lead.
   */
  it('never escalates while the lane already holds runtime evidence', async () => {
    const rebootstrapPrimaryLane = vi.fn(async () => true);
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs: () => T0 + 10 * 60_000,
      inspectLaneStorage: async () => COMMITTED_LANE_STORAGE,
      rebootstrapPrimaryLane,
    });

    expect((await tracker.request(request)).action).toBe('not_applicable');
    expect(rebootstrapPrimaryLane).not.toHaveBeenCalled();
  });

  it('treats an unreadable lane directory as "not proven unbootstrapped"', async () => {
    const rebootstrapPrimaryLane = vi.fn(async () => true);
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs: () => T0 + 10 * 60_000,
      inspectLaneStorage: async () => {
        throw new Error('EBUSY');
      },
      rebootstrapPrimaryLane,
    });

    expect((await tracker.request(request)).action).toBe('not_applicable');
    expect(rebootstrapPrimaryLane).not.toHaveBeenCalled();
  });

  it('never escalates a lane whose directory does not exist for this run', async () => {
    const rebootstrapPrimaryLane = vi.fn(async () => true);
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs: () => T0 + 10 * 60_000,
      // A reattached/recovered lane that this run never bootstrapped belongs to
      // the recovery flows, not to the self-heal.
      inspectLaneStorage: async () => ({
        laneDirectoryExists: false,
        hasStateOnDisk: false,
        hasRuntimeEvidenceOnDisk: false,
      }),
      rebootstrapPrimaryLane,
    });

    expect((await tracker.request(request)).action).toBe('not_applicable');
    expect(rebootstrapPrimaryLane).not.toHaveBeenCalled();
  });

  /**
   * Negative control for the opt-out at the tracker boundary: nothing is
   * relaunched, and the decision is terminal rather than an endless wait.
   */
  it('starts no relaunch at all when the opt-out port disables the self-heal', async () => {
    const rebootstrapPrimaryLane = vi.fn(async () => true);
    const tracker = new OpenCodePrimaryLaneBootstrapSelfHealTracker({
      nowMs: () => T0 + 10 * 60_000,
      inspectLaneStorage: async () => UNBOOTSTRAPPED_LANE_STORAGE,
      isOpenCodePrimaryLaneSelfHealEnabled: () => false,
      rebootstrapPrimaryLane,
    });

    const decision = await tracker.request(request);

    expect(decision).toEqual({
      action: 'give_up',
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC,
    });
    expect(rebootstrapPrimaryLane).not.toHaveBeenCalled();
  });

  it('keys entries per team and run without leaking the ladder across teams', async () => {
    let now = T0;
    const { tracker, rebootstrapPrimaryLane } = createTracker(() => now);

    await tracker.request(request);
    now = T0 + 21_000;
    await tracker.request(request);
    await settle();
    tracker.reset(request.teamName, request.runId);
    // A reset run starts its grace window again rather than inheriting the
    // previous window's elapsed time.
    expect((await tracker.request(request)).action).toBe('wait');
    expect(rebootstrapPrimaryLane).toHaveBeenCalledTimes(1);
  });
});
