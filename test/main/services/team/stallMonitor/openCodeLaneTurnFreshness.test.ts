import { afterEach, describe, expect, it, vi } from 'vitest';

const { laneFreshnessWarn } = vi.hoisted(() => ({ laneFreshnessWarn: vi.fn() }));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: laneFreshnessWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  getOpenCodeLaneTurnActivityMaxAgeMs,
  getOpenCodeWeakStartStallThresholdMs,
  getPendingPickupStallThresholdMs,
} from '@main/services/team/stallMonitor/featureGates';
import {
  classifyOpenCodeLaneTurnSample,
  resolveOpenCodeLaneTurnActivityMaxAgeMs,
} from '@main/services/team/stallMonitor/openCodeLaneTurnFreshness';
import { WORK_THRESHOLDS_MS } from '@main/services/team/stallMonitor/TeamTaskStallPolicy';

afterEach(() => {
  vi.unstubAllEnvs();
  laneFreshnessWarn.mockClear();
});

const OBSERVED_AT = '2026-04-19T12:00:00.000Z';
const OBSERVED_AT_MS = Date.parse(OBSERVED_AT);
const MAX_AGE_MS = 10 * 60_000;

function classifyActiveAtAge(ageMs: number) {
  return classifyOpenCodeLaneTurnSample({
    sample: { laneId: 'secondary:opencode:scout', state: 'active', observedAt: OBSERVED_AT },
    nowMs: OBSERVED_AT_MS + ageMs,
    maxAgeMs: MAX_AGE_MS,
  });
}

function expectOrderingInvariant(maxAgeMs: number): void {
  // A demotion publishes a backdated idle time that the work branch reads as
  // "the turn ended at that moment". Below any of these thresholds a
  // legitimately long turn is demoted mid-generation and the `lane_active`
  // guard becomes unreachable for exactly the turns it exists to protect.
  expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.mid_turn_after_touch);
  expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.touch_then_other_turns);
  expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.turn_ended_after_touch);
  expect(maxAgeMs).toBeGreaterThanOrEqual(getOpenCodeWeakStartStallThresholdMs());
  expect(maxAgeMs).toBeGreaterThanOrEqual(getPendingPickupStallThresholdMs());
}

describe('getOpenCodeLaneTurnActivityMaxAgeMs ordering invariant', () => {
  it('stays at or above every OpenCode stall threshold the lane_active guard can unlock', () => {
    expectOrderingInvariant(getOpenCodeLaneTurnActivityMaxAgeMs());
  });
});

describe('resolveOpenCodeLaneTurnActivityMaxAgeMs', () => {
  it('holds the ordering invariant against an environment override, not only the default', () => {
    // The default satisfies the invariant, but a default is not a bound: this
    // override would demote a lane one minute into a five-minute turn and take
    // the `lane_active` guard off exactly the turns it protects.
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS', '60000');

    const resolvedMs = resolveOpenCodeLaneTurnActivityMaxAgeMs();

    expect(resolvedMs).toBe(WORK_THRESHOLDS_MS.mid_turn_after_touch);
    expectOrderingInvariant(resolvedMs);
  });

  it('raises the floor with the thresholds it protects', () => {
    // The weak-start threshold is itself overridable, and a lane bound below it
    // is under-floor however large it looks on its own.
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_WEAK_START_STALL_THRESHOLD_MS', '1800000');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS', '900000');

    const resolvedMs = resolveOpenCodeLaneTurnActivityMaxAgeMs();

    expect(resolvedMs).toBe(1_800_000);
    expectOrderingInvariant(resolvedMs);
  });

  it('passes through the default and any override at or above the floor', () => {
    expect(resolveOpenCodeLaneTurnActivityMaxAgeMs()).toBe(getOpenCodeLaneTurnActivityMaxAgeMs());

    // Longer is always safe: a lane stays trusted as mid-turn for longer, which
    // can only delay an alert, never fire one inside a live turn.
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS', '1200000');
    expect(resolveOpenCodeLaneTurnActivityMaxAgeMs()).toBe(1_200_000);
    expect(laneFreshnessWarn).not.toHaveBeenCalled();
  });

  it('reports an out-of-range override once instead of on every scan', () => {
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS', '61000');

    resolveOpenCodeLaneTurnActivityMaxAgeMs();
    resolveOpenCodeLaneTurnActivityMaxAgeMs();
    resolveOpenCodeLaneTurnActivityMaxAgeMs();

    // The scan runs every 30 s, so a warn per read would be a log flood for a
    // setting that is wrong exactly once, at startup.
    expect(laneFreshnessWarn).toHaveBeenCalledTimes(1);
    expect(laneFreshnessWarn.mock.calls[0][0]).toContain('61000');
    expect(laneFreshnessWarn.mock.calls[0][0]).toContain(
      String(WORK_THRESHOLDS_MS.mid_turn_after_touch)
    );
  });
});

describe('classifyOpenCodeLaneTurnSample', () => {
  it('never treats an idle sample as stale, however old it is', () => {
    const verdict = classifyOpenCodeLaneTurnSample({
      sample: { laneId: 'secondary:opencode:scout', state: 'idle', observedAt: OBSERVED_AT },
      nowMs: OBSERVED_AT_MS + 1000 * MAX_AGE_MS,
      maxAgeMs: MAX_AGE_MS,
    });

    // "The turn ended" does not decay: only a new 'active' sample can undo it.
    expect(verdict).toEqual({ treatAsActive: false, idleSince: OBSERVED_AT });
    expect(verdict.staleActiveSince).toBeUndefined();
  });

  it('treats an active sample with an unparsable observation time as stale', () => {
    const verdict = classifyOpenCodeLaneTurnSample({
      sample: { laneId: 'secondary:opencode:scout', state: 'active', observedAt: 'not-a-date' },
      nowMs: OBSERVED_AT_MS,
      maxAgeMs: MAX_AGE_MS,
    });

    // Fail-safe direction is "do not stay silent". No idle time is published
    // either, so the pickup branch falls back to its own readiness clock rather
    // than starting from a timestamp nobody can read.
    expect(verdict).toEqual({
      treatAsActive: false,
      idleSince: null,
      staleActiveSince: 'not-a-date',
    });
  });

  it('expires an active sample exactly at the max age and not one millisecond earlier', () => {
    expect(classifyActiveAtAge(MAX_AGE_MS - 1)).toEqual({
      treatAsActive: true,
      idleSince: null,
      activeSince: OBSERVED_AT,
    });
    expect(classifyActiveAtAge(MAX_AGE_MS)).toEqual({
      treatAsActive: false,
      idleSince: OBSERVED_AT,
      staleActiveSince: OBSERVED_AT,
    });
  });

  it('backdates a demoted sample to its original observation instead of to now', () => {
    // Demoting to `now` would restart the pickup clock on every scan and
    // re-hide the stall for another threshold window.
    expect(classifyActiveAtAge(50 * MAX_AGE_MS).idleSince).toBe(OBSERVED_AT);
  });
});
