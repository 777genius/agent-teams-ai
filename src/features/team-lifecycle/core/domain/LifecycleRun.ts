import type {
  LaunchTeamRequest,
  LifecycleLaneStatus,
  LifecycleRunRef,
  LifecycleRunStatus,
  LifecycleRunStatusView,
} from '../../contracts';

export type LifecycleRuntimePlan = LaunchTeamRequest['plan'];
export type LifecycleRuntimeLaneId = LifecycleRuntimePlan['lanes'][number]['laneId'];
type LifecycleRuntimeTopologyMode = LifecycleRuntimePlan['topologyMode'];

export const LIFECYCLE_RUN_AGGREGATE_VERSION = 1 as const;

export type LifecycleRunIntent = 'cancel' | 'stop' | 'recover';

export interface LifecycleRunLane {
  readonly laneId: LifecycleRuntimeLaneId;
  readonly ordinal: number;
  readonly status: LifecycleLaneStatus;
  readonly executionRef: string | null;
  readonly diagnostic: string | null;
}

export interface LifecycleRun {
  readonly aggregateVersion: typeof LIFECYCLE_RUN_AGGREGATE_VERSION;
  readonly runId: LifecycleRuntimePlan['runId'];
  readonly teamId: LifecycleRuntimePlan['teamId'];
  readonly generation: number;
  readonly revision: number;
  readonly status: LifecycleRunStatus;
  /** Retains an interrupted drain goal so recovery cannot accidentally relaunch it. */
  readonly activeIntent: LifecycleRunIntent | null;
  readonly drainMode: 'graceful' | 'immediate' | null;
  /** The exact accepted object. Domain transitions never clone, edit, or rebuild it. */
  readonly plan: LifecycleRuntimePlan;
  readonly acceptedAt: string;
  readonly lanes: readonly LifecycleRunLane[];
}

export function createLifecycleRun(plan: LifecycleRuntimePlan, acceptedAt: string): LifecycleRun {
  if (!isDeepFrozen(plan)) throw new TypeError('lifecycle-run-plan-must-be-immutable');
  assertCanonicalTimestamp(acceptedAt);
  const lanes = plan.orderedLaneIds.map((laneId, ordinal) =>
    Object.freeze({
      laneId,
      ordinal,
      status: 'queued' as const,
      executionRef: null,
      diagnostic: null,
    })
  );
  return freezeRun({
    aggregateVersion: LIFECYCLE_RUN_AGGREGATE_VERSION,
    runId: plan.runId,
    teamId: plan.teamId,
    generation: plan.generation,
    revision: 1,
    status: 'accepted',
    activeIntent: null,
    drainMode: null,
    plan,
    acceptedAt,
    lanes,
  });
}

export function lifecycleRunRef(run: LifecycleRun): LifecycleRunRef {
  return Object.freeze({ runId: run.runId, generation: run.generation });
}

export function lifecycleRunStatusView(run: LifecycleRun): LifecycleRunStatusView {
  return Object.freeze({
    runId: run.runId,
    generation: run.generation,
    planHash: run.plan.planHash,
    status: run.status,
    revision: run.revision,
    lanes: Object.freeze(
      run.lanes.map((lane) =>
        Object.freeze({
          laneId: lane.laneId,
          ordinal: lane.ordinal,
          status: lane.status,
          diagnostic: lane.diagnostic,
        })
      )
    ),
  });
}

export function eligibleQueuedLaneIds(run: LifecycleRun): readonly LifecycleRuntimeLaneId[] {
  if (isTerminalLifecycleRun(run) || run.status === 'operator_required') return Object.freeze([]);
  const queued = run.lanes.filter((lane) => lane.status === 'queued');
  if (queued.length === 0) return Object.freeze([]);
  if (run.plan.topologyMode !== 'mixed_opencode_side_lanes') {
    return Object.freeze(queued.map((lane) => lane.laneId));
  }
  const primary = primaryLane(run);
  if (!primary) return Object.freeze([]);
  if (primary.status === 'queued') return Object.freeze([primary.laneId]);
  if (primary.status !== 'ready') return Object.freeze([]);
  return Object.freeze(
    queued.filter((lane) => lane.laneId !== primary.laneId).map((lane) => lane.laneId)
  );
}

export function markLifecycleLaneLaunching(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId
): LifecycleRun {
  assertMutableRun(run);
  return updateLane(run, laneId, (lane) => {
    if (lane.status !== 'queued') throw new TypeError('lifecycle-run-lane-not-queued');
    return { ...lane, status: 'launching', diagnostic: null };
  });
}

export function applyLifecycleLaneLaunch(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId,
  outcome:
    | { readonly status: 'launched' | 'already_launched'; readonly executionRef: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
): LifecycleRun {
  return updateLane(run, laneId, (lane) => {
    if (lane.status !== 'launching') throw new TypeError('lifecycle-run-lane-not-launching');
    if (outcome.status === 'launched' || outcome.status === 'already_launched') {
      return {
        ...lane,
        status: 'starting',
        executionRef: outcome.executionRef,
        diagnostic: null,
      };
    }
    if (outcome.status === 'operator_required') {
      return { ...lane, status: 'operator_required', diagnostic: outcome.diagnostic };
    }
    return {
      ...lane,
      status: 'failed',
      diagnostic: 'diagnostic' in outcome ? outcome.diagnostic : 'runtime-launch-rejected',
    };
  });
}

export function applyLifecycleLaneObservation(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId,
  outcome:
    | { readonly status: 'starting' | 'ready' | 'degraded' | 'stopping' }
    | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
): LifecycleRun {
  return updateLane(run, laneId, (lane) => {
    if (lane.status === 'operator_required' && outcome.status !== 'operator_required') {
      return lane;
    }
    if (outcome.status === 'operator_required') {
      return { ...lane, status: 'operator_required', diagnostic: outcome.diagnostic };
    }
    if (outcome.status === 'rejected') {
      return { ...lane, status: 'degraded', diagnostic: outcome.diagnostic };
    }
    if (outcome.status === 'exited') {
      if (run.activeIntent === 'cancel' || run.activeIntent === 'stop') {
        return {
          ...lane,
          status: 'operator_required',
          diagnostic: `runtime-exited-${outcome.outcome}-during-${run.activeIntent}-without-conclusive-effect-evidence`,
        };
      }
      return {
        ...lane,
        status: 'failed',
        diagnostic: `runtime-exited-${outcome.outcome}`,
      };
    }
    return {
      ...lane,
      status: outcome.status,
      diagnostic: outcome.status === 'degraded' ? 'runtime-degraded' : null,
    };
  });
}

export function beginLifecycleRunIntent(
  run: LifecycleRun,
  intent: LifecycleRunIntent,
  drainMode?: 'graceful' | 'immediate',
  possiblyStartedLaneIds: readonly LifecycleRuntimeLaneId[] = Object.freeze([])
): LifecycleRun {
  if (isTerminalLifecycleRun(run)) throw new TypeError('lifecycle-run-terminal');
  const retainedIntent = intent === 'recover' ? (run.activeIntent ?? intent) : intent;
  const target =
    retainedIntent === 'cancel'
      ? 'cancelling'
      : retainedIntent === 'stop'
        ? 'stopping'
        : 'recovering';
  const retainedDrainMode =
    retainedIntent === 'cancel'
      ? 'graceful'
      : retainedIntent === 'stop'
        ? (drainMode ?? run.drainMode ?? 'graceful')
        : null;
  const lanes = run.lanes.map((lane) => {
    if (retainedIntent === 'recover') return lane;
    if (lane.executionRef === null && !possiblyStartedLaneIds.includes(lane.laneId)) {
      return Object.freeze({ ...lane, status: 'cancelled' as const, diagnostic: null });
    }
    if (isTerminalLaneStatus(lane.status)) return lane;
    return Object.freeze({
      ...lane,
      status: retainedIntent === 'cancel' ? ('cancelling' as const) : ('stopping' as const),
    });
  });
  return freezeRun({
    ...run,
    revision: run.revision + 1,
    status: deriveLifecycleRunStatus(target, retainedIntent, lanes),
    activeIntent: retainedIntent,
    drainMode: retainedDrainMode,
    lanes,
  });
}

export function applyLifecycleLaneStop(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId,
  outcome:
    | { readonly status: 'stopped' | 'already_stopped' | 'cancelled' }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string }
): LifecycleRun {
  return updateLane(run, laneId, (lane) => {
    if (outcome.status === 'operator_required') {
      return { ...lane, status: 'operator_required', diagnostic: outcome.diagnostic };
    }
    if (outcome.status === 'rejected') {
      return { ...lane, status: 'degraded', diagnostic: outcome.diagnostic };
    }
    return {
      ...lane,
      status: run.activeIntent === 'cancel' ? 'cancelled' : 'stopped',
      diagnostic: null,
    };
  });
}

export function applyLifecycleLaneRecovery(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId,
  outcome:
    | { readonly status: 'not_started' }
    | { readonly status: 'cancelled' }
    | { readonly status: 'recovered'; readonly executionRef: string }
    | { readonly status: 'operator_required'; readonly diagnostic: string }
    | { readonly status: 'rejected'; readonly diagnostic: string },
  notStartedDisposition: 'queued' | 'cancelled' | 'stopped' = 'queued'
): LifecycleRun {
  return updateLane(run, laneId, (lane) => {
    if (outcome.status === 'not_started') {
      return {
        ...lane,
        status: notStartedDisposition,
        executionRef: null,
        diagnostic: null,
      };
    }
    if (outcome.status === 'cancelled') {
      return { ...lane, status: 'cancelled', diagnostic: null };
    }
    if (outcome.status === 'recovered') {
      return {
        ...lane,
        status: 'starting',
        executionRef: outcome.executionRef,
        diagnostic: null,
      };
    }
    if (outcome.status === 'operator_required') {
      return { ...lane, status: 'operator_required', diagnostic: outcome.diagnostic };
    }
    return { ...lane, status: 'degraded', diagnostic: outcome.diagnostic };
  });
}

export function isTerminalLifecycleRun(run: LifecycleRun): boolean {
  return run.status === 'cancelled' || run.status === 'stopped' || run.status === 'failed';
}

export function isStartedLifecycleLane(lane: LifecycleRunLane): boolean {
  return lane.executionRef !== null;
}

export function topologyStartsSideLanesAfterPrimary(mode: LifecycleRuntimeTopologyMode): boolean {
  return mode === 'mixed_opencode_side_lanes';
}

function updateLane(
  run: LifecycleRun,
  laneId: LifecycleRuntimeLaneId,
  update: (lane: LifecycleRunLane) => LifecycleRunLane
): LifecycleRun {
  assertMutableRun(run);
  let found = false;
  const lanes = run.lanes.map((lane) => {
    if (lane.laneId !== laneId) return lane;
    if (found) throw new TypeError('lifecycle-run-lane-ambiguous');
    found = true;
    return Object.freeze(update(lane));
  });
  if (!found) throw new TypeError('lifecycle-run-lane-not-found');
  return freezeRun({
    ...run,
    revision: run.revision + 1,
    lanes,
    status: deriveLifecycleRunStatus(run.status, run.activeIntent, lanes),
  });
}

function deriveLifecycleRunStatus(
  current: LifecycleRunStatus,
  activeIntent: LifecycleRunIntent | null,
  lanes: readonly LifecycleRunLane[]
): LifecycleRunStatus {
  if (lanes.some((lane) => lane.status === 'operator_required')) return 'operator_required';
  if (current === 'cancelling' || (current === 'recovering' && activeIntent === 'cancel')) {
    if (lanes.every((lane) => lane.status === 'cancelled' || lane.status === 'stopped')) {
      return 'cancelled';
    }
    return lanes.some((lane) => lane.status === 'degraded' || lane.status === 'failed')
      ? 'recovering'
      : 'cancelling';
  }
  if (current === 'stopping' || (current === 'recovering' && activeIntent === 'stop')) {
    if (
      lanes.every((lane) => ['cancelled', 'stopped', 'failed'].includes(lane.status)) &&
      lanes.every((lane) => lane.status !== 'degraded')
    ) {
      return lanes.some((lane) => lane.status === 'failed') ? 'degraded' : 'stopped';
    }
    return lanes.some((lane) => lane.status === 'degraded') ? 'recovering' : 'stopping';
  }
  if (lanes.every((lane) => lane.status === 'ready')) return 'ready';
  if (lanes.some((lane) => ['degraded', 'failed'].includes(lane.status))) return 'degraded';
  if (current === 'recovering') return 'recovering';
  if (lanes.some((lane) => lane.status !== 'queued')) return 'provisioning';
  return current === 'accepted' ? 'accepted' : 'provisioning';
}

function primaryLane(run: LifecycleRun): LifecycleRunLane | undefined {
  const primaryId = run.plan.lanes.find((lane) => lane.laneKind === 'primary')?.laneId;
  return run.lanes.find((lane) => lane.laneId === primaryId);
}

function isTerminalLaneStatus(status: LifecycleLaneStatus): boolean {
  return status === 'cancelled' || status === 'stopped' || status === 'failed';
}

function assertMutableRun(run: LifecycleRun): void {
  if (isTerminalLifecycleRun(run)) throw new TypeError('lifecycle-run-terminal');
}

function freezeRun(run: LifecycleRun): LifecycleRun {
  return Object.freeze({ ...run, lanes: Object.freeze([...run.lanes]) });
}

function assertCanonicalTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('lifecycle-run-timestamp-invalid');
  }
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeepFrozen(child, seen));
}
