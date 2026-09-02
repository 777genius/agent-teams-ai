import { describe, expect, it } from 'vitest';

import {
  getOpenCodeLaneTurnActivityMaxAgeMs,
  getOpenCodeWeakStartStallThresholdMs,
  getPendingPickupStallThresholdMs,
} from '../../../../../src/main/services/team/stallMonitor/featureGates';
import { classifyOpenCodeLaneTurnSample } from '../../../../../src/main/services/team/stallMonitor/openCodeLaneTurnFreshness';
import { WORK_THRESHOLDS_MS } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallPolicy';

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

describe('getOpenCodeLaneTurnActivityMaxAgeMs ordering invariant', () => {
  it('stays at or above every OpenCode stall threshold the lane_active guard can unlock', () => {
    const maxAgeMs = getOpenCodeLaneTurnActivityMaxAgeMs();

    // A demotion publishes a backdated idle time that the work branch reads as
    // "the turn ended at that moment". Below any of these thresholds a
    // legitimately long turn is demoted mid-generation and the `lane_active`
    // guard becomes unreachable for exactly the turns it exists to protect.
    expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.mid_turn_after_touch);
    expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.touch_then_other_turns);
    expect(maxAgeMs).toBeGreaterThanOrEqual(WORK_THRESHOLDS_MS.turn_ended_after_touch);
    expect(maxAgeMs).toBeGreaterThanOrEqual(getOpenCodeWeakStartStallThresholdMs());
    expect(maxAgeMs).toBeGreaterThanOrEqual(getPendingPickupStallThresholdMs());
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
