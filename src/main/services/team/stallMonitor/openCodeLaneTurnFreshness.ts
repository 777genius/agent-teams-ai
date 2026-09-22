import { createLogger } from '@shared/utils/logger';

import {
  getOpenCodeLaneTurnActivityMaxAgeMs,
  getOpenCodeWeakStartStallThresholdMs,
  getPendingPickupStallThresholdMs,
} from './featureGates';
import { WORK_THRESHOLDS_MS } from './TeamTaskStallPolicy';

import type { OpenCodeLaneTurnActivitySample } from '../opencode/delivery/OpenCodeLaneTurnActivityRegistry';

/**
 * Freshness rule for one OpenCode lane turn sample.
 *
 * INVARIANT: the stall monitor's "is this owner actually busy?" signal must
 * never be silenceable indefinitely by the subsystem the monitor supervises.
 * `OpenCodeLaneTurnActivityRegistry` is a last-write-wins in-memory map fed by
 * the delivery service's own settle paths, so a lane whose settle never runs
 * stays advertised as mid-turn for as long as the jam lasts - and every
 * OpenCode stall branch reads that flag as "the owner is working, stay quiet".
 * A jammed delivery lane therefore switches off the detector for the jam.
 *
 * The shape this exists for was recorded in a multi-hour mixed-provider run
 * (2026-08-28). A user-DM delivery record on one member's lane was accepted at
 * 08:09:43.105Z and then sat at `status: retry_scheduled`, `responseState:
 * not_observed`, `lastTurnProgressAt: null` until 08:19:41.340Z. Nothing moved
 * in the ledger for ten minutes, yet the registry sample stayed
 * `active @ 08:09:43.105Z`, so a pending task owned by that member - every
 * blocker resolved at 08:09:55.325Z, owner working nothing else - was skipped
 * with `lane_active` on every scan, and the stall journal was still empty at
 * 08:17:30.325Z.
 *
 * Defense in depth, deliberately. The individual deadlock that froze that
 * sample is fixed on the delivery side, but that repair depends on a dispatch
 * actually happening and covers that one cause only. The age bound is what
 * makes a stale flag from any future cause - including a lane nothing tries to
 * dispatch to - unable to silence pickup detection.
 */

const logger = createLogger('Service:OpenCodeLaneTurnFreshness');

/** Remembers the last override reported as out of range so a misconfigured
 * install gets one warn line, not one per scan. */
let lastReportedUnderfloorMaxAgeMs: number | null = null;

/**
 * The smallest age bound that still satisfies the ordering invariant: every
 * OpenCode stall threshold whose `lane_active` guard a demotion can unlock.
 * Read live, because the weak-start and pickup thresholds are themselves
 * overridable and raising either raises this floor with it.
 */
function getOpenCodeLaneTurnActivityMaxAgeFloorMs(): number {
  return Math.max(
    ...Object.values(WORK_THRESHOLDS_MS),
    getOpenCodeWeakStartStallThresholdMs(),
    getPendingPickupStallThresholdMs()
  );
}

/**
 * The age bound the snapshot actually applies.
 *
 * `getOpenCodeLaneTurnActivityMaxAgeMs` reads a positive integer from the
 * environment and nothing more, so an override below the floor above would
 * demote a lane in the middle of a legitimate turn: at
 * CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS=60000 a member one minute
 * into a five-minute turn is published as idle, the `lane_active` guard the
 * weak-start branch relies on never fires, and the nudge lands mid-generation -
 * the exact failure the guard exists to prevent. The invariant is only tested
 * against the default, and a default is not a bound.
 *
 * An under-floor override is therefore raised to the floor rather than
 * accepted: it can still be set higher, which is always safe (a lane stays
 * trusted for longer), but it cannot be set to a value that switches the guard
 * off.
 */
export function resolveOpenCodeLaneTurnActivityMaxAgeMs(): number {
  const configuredMs = getOpenCodeLaneTurnActivityMaxAgeMs();
  const floorMs = getOpenCodeLaneTurnActivityMaxAgeFloorMs();
  if (configuredMs >= floorMs) {
    return configuredMs;
  }
  if (lastReportedUnderfloorMaxAgeMs !== configuredMs) {
    lastReportedUnderfloorMaxAgeMs = configuredMs;
    logger.warn(
      `CLAUDE_TEAM_OPENCODE_LANE_TURN_ACTIVITY_MAX_AGE_MS=${configuredMs} is below the ${floorMs}ms OpenCode stall floor and would demote a lane mid-turn; using ${floorMs}ms`
    );
  }
  return floorMs;
}

export interface OpenCodeLaneTurnVerdict {
  /** Whether the pickup and work branches should treat the owner as mid-turn. */
  treatAsActive: boolean;
  /** ISO time the lane has been idle since, or null when there is no evidence. */
  idleSince: string | null;
  /** Set only on a demotion: the ISO time of the sample that went stale. */
  staleActiveSince?: string;
  /** Set only while the sample is trusted as active: when that turn started. */
  activeSince?: string;
}

/** Whether an 'active' sample has outlived the window in which it is evidence. */
function isActiveSampleExpired(args: {
  observedAt: string;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  const observedAtMs = Date.parse(args.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    // Fail-safe direction is "do not stay silent": a sample whose clock cannot
    // be read is exactly the sample that could otherwise suppress alerts
    // forever, so it is treated as expired rather than as fresh evidence.
    return true;
  }
  return args.nowMs - observedAtMs >= args.maxAgeMs;
}

/**
 * Classify one lane sample into the snapshot's active/idle evidence.
 *
 * `maxAgeMs` carries an ordering invariant rather than being a free knob: a
 * demotion publishes a backdated `idleSince` that the work branches read as
 * "the turn ENDED at that moment", so the bound must sit at or above the
 * largest stall threshold that evidence can unlock.
 * `getOpenCodeLaneTurnActivityMaxAgeMs` documents the arithmetic; below it, a
 * legitimately long turn is demoted mid-generation and the `lane_active` guard
 * that protects it can never fire.
 */
export function classifyOpenCodeLaneTurnSample(args: {
  sample: OpenCodeLaneTurnActivitySample;
  nowMs: number;
  maxAgeMs: number;
}): OpenCodeLaneTurnVerdict {
  const { sample } = args;
  if (sample.state === 'idle') {
    // An idle sample states that a turn ENDED, and that fact does not decay:
    // the lane cannot become busy again without the delivery service writing a
    // new 'active' sample over it. Age is irrelevant here, and the bound below
    // never sees an idle sample.
    return { treatAsActive: false, idleSince: sample.observedAt };
  }

  if (
    !isActiveSampleExpired({
      observedAt: sample.observedAt,
      nowMs: args.nowMs,
      maxAgeMs: args.maxAgeMs,
    })
  ) {
    return { treatAsActive: true, idleSince: null, activeSince: sample.observedAt };
  }

  if (!Number.isFinite(Date.parse(sample.observedAt))) {
    // No usable clock at all: demote, but publish no idle time either. The
    // pickup branch then falls back to its own readiness clock instead of
    // quietly starting from a timestamp nobody can read.
    return { treatAsActive: false, idleSince: null, staleActiveSince: sample.observedAt };
  }
  // `idleSince` is the ORIGINAL observation, never `now`. The pickup branch
  // starts its clock at the later of its own readiness time and this one, so
  // demoting to `now` would restart that clock and re-hide the stall for
  // another threshold window - exactly the outcome this bound exists to
  // prevent.
  return {
    treatAsActive: false,
    idleSince: sample.observedAt,
    staleActiveSince: sample.observedAt,
  };
}
