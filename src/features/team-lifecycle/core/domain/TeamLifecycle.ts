import {
  type DeploymentId,
  parseDeploymentId,
  parseRunId,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import { admitCanonicalLaunch, type LegacyRuntimeCutover } from './LegacyRuntimeCutover';

import type { LaunchTeamRequest, LifecycleRunRef, LifecycleRunStatus } from '../../contracts';

type LifecycleRuntimePlan = LaunchTeamRequest['plan'];

export const TEAM_LIFECYCLE_AGGREGATE_VERSION = 1 as const;
export const LIFECYCLE_WRITER_BARRIER_SCHEMA_VERSION = 1 as const;

export interface LifecycleWriterWatermark {
  readonly fileWriterEpoch: number;
  readonly observationSequence: number;
}

export interface LifecycleWriterBarrierReceipt {
  readonly schemaVersion: typeof LIFECYCLE_WRITER_BARRIER_SCHEMA_VERSION;
  readonly barrierId: string;
  readonly teamId: TeamId;
  readonly previousFileWriterEpoch: number;
  readonly nextFileWriterEpoch: number;
  readonly drainedThrough: LifecycleWriterWatermark;
  readonly preparedAtIso: string;
}

export type TeamLifecycleAggregateState =
  | 'draft'
  | 'idle'
  | 'active'
  | 'soft_deleted'
  | 'deleting'
  | 'deleted';

export interface TeamLifecycle {
  readonly aggregateVersion: typeof TEAM_LIFECYCLE_AGGREGATE_VERSION;
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly revision: number;
  readonly state: TeamLifecycleAggregateState;
  readonly lastGeneration: number;
  readonly currentRunRef: LifecycleRunRef | null;
  readonly fileWriterEpoch: number;
  /** Durable stale-writer fence for the accepted canonical generation. */
  readonly writerBarrierReceipt: LifecycleWriterBarrierReceipt | null;
  readonly cutover: LegacyRuntimeCutover;
}

export function createTeamLifecycle(input: {
  readonly deploymentId: DeploymentId;
  readonly teamId: TeamId;
  readonly revision?: number;
  readonly state?: TeamLifecycleAggregateState;
  readonly lastGeneration?: number;
  readonly currentRunRef?: LifecycleRunRef | null;
  readonly fileWriterEpoch?: number;
  readonly writerBarrierReceipt?: LifecycleWriterBarrierReceipt | null;
  readonly cutover: LegacyRuntimeCutover;
}): TeamLifecycle {
  const revision = input.revision ?? 1;
  const legacyLastGeneration =
    input.cutover.mode === 'legacy_drain'
      ? Math.max(...input.cutover.candidates.map((candidate) => candidate.generation))
      : 0;
  const lastGeneration = input.lastGeneration ?? legacyLastGeneration;
  const fileWriterEpoch = input.fileWriterEpoch ?? 0;
  const writerBarrierReceipt = input.writerBarrierReceipt
    ? parseLifecycleWriterBarrierReceipt(input.writerBarrierReceipt, input.teamId)
    : null;
  if (!Object.isFrozen(input.cutover)) {
    throw new TypeError('team-lifecycle-cutover-must-be-immutable');
  }
  assertPositiveInteger(revision, 'team-lifecycle-revision-invalid');
  assertNonNegativeInteger(lastGeneration, 'team-lifecycle-generation-invalid');
  assertNonNegativeInteger(fileWriterEpoch, 'team-lifecycle-file-writer-epoch-invalid');
  const currentRunRef = input.currentRunRef ? parseLifecycleRunRef(input.currentRunRef) : null;
  if (currentRunRef && currentRunRef.generation > lastGeneration) {
    throw new TypeError('team-lifecycle-current-run-ref-invalid');
  }
  if (
    (fileWriterEpoch === 0 && writerBarrierReceipt !== null) ||
    (writerBarrierReceipt !== null &&
      writerBarrierReceipt.nextFileWriterEpoch !== fileWriterEpoch) ||
    (fileWriterEpoch > 0 && input.cutover.mode === 'canonical' && writerBarrierReceipt === null)
  ) {
    throw new TypeError('team-lifecycle-writer-barrier-invalid');
  }
  const state = input.state ?? 'idle';
  if (
    !['draft', 'idle', 'active', 'soft_deleted', 'deleting', 'deleted'].includes(state) ||
    (state === 'active' && !currentRunRef)
  ) {
    throw new TypeError('team-lifecycle-state-invalid');
  }
  return Object.freeze({
    aggregateVersion: TEAM_LIFECYCLE_AGGREGATE_VERSION,
    deploymentId: parseDeploymentId(input.deploymentId),
    teamId: parseTeamId(input.teamId),
    revision,
    state,
    lastGeneration,
    currentRunRef,
    fileWriterEpoch,
    writerBarrierReceipt,
    cutover: input.cutover,
  });
}

export function acceptLifecycleRun(
  lifecycle: TeamLifecycle,
  plan: LifecycleRuntimePlan,
  writerBarrierReceipt: LifecycleWriterBarrierReceipt
): TeamLifecycle {
  const admission = admitCanonicalLaunch(lifecycle.cutover);
  if (admission.status === 'rejected') throw new TypeError(admission.reason);
  if (
    lifecycle.state === 'soft_deleted' ||
    lifecycle.state === 'deleting' ||
    lifecycle.state === 'deleted'
  ) {
    throw new TypeError('team-lifecycle-launch-state-invalid');
  }
  if (plan.teamId !== lifecycle.teamId) throw new TypeError('team-lifecycle-plan-team-mismatch');
  if (plan.generation !== lifecycle.lastGeneration + 1) {
    throw new TypeError('team-lifecycle-plan-generation-nonmonotonic');
  }
  const receipt = parseLifecycleWriterBarrierReceipt(writerBarrierReceipt, lifecycle.teamId);
  if (
    receipt.previousFileWriterEpoch !== lifecycle.fileWriterEpoch ||
    receipt.nextFileWriterEpoch !== lifecycle.fileWriterEpoch + 1 ||
    receipt.drainedThrough.fileWriterEpoch !== lifecycle.fileWriterEpoch
  ) {
    throw new TypeError('team-lifecycle-file-writer-epoch-nonmonotonic');
  }
  return Object.freeze({
    ...lifecycle,
    revision: lifecycle.revision + 1,
    state: 'active',
    lastGeneration: plan.generation,
    currentRunRef: Object.freeze({
      runId: parseRunId(plan.runId),
      generation: plan.generation,
    }),
    fileWriterEpoch: receipt.nextFileWriterEpoch,
    writerBarrierReceipt: receipt,
  });
}

export function applyCurrentRunStatus(
  lifecycle: TeamLifecycle,
  runRef: LifecycleRunRef,
  status: LifecycleRunStatus
): TeamLifecycle {
  if (!isCurrentLifecycleRun(lifecycle, runRef)) {
    throw new TypeError('team-lifecycle-stale-generation');
  }
  const state: TeamLifecycleAggregateState = isTerminalRunStatus(status) ? 'idle' : 'active';
  return Object.freeze({ ...lifecycle, revision: lifecycle.revision + 1, state });
}

export function replaceLegacyRuntimeCutover(
  lifecycle: TeamLifecycle,
  cutover: LegacyRuntimeCutover
): TeamLifecycle {
  if (lifecycle.cutover.mode === 'canonical' && cutover.mode !== 'canonical') {
    throw new TypeError('team-lifecycle-cutover-one-way');
  }
  if (!Object.isFrozen(cutover) || cutover.revision <= lifecycle.cutover.revision) {
    throw new TypeError('team-lifecycle-cutover-revision-invalid');
  }
  return Object.freeze({ ...lifecycle, revision: lifecycle.revision + 1, cutover });
}

export function isCurrentLifecycleRun(lifecycle: TeamLifecycle, runRef: LifecycleRunRef): boolean {
  return (
    lifecycle.currentRunRef?.runId === runRef.runId &&
    lifecycle.currentRunRef.generation === runRef.generation
  );
}

export function isTerminalRunStatus(status: LifecycleRunStatus): boolean {
  return status === 'cancelled' || status === 'stopped' || status === 'failed';
}

export function parseLifecycleRunRef(value: LifecycleRunRef): LifecycleRunRef {
  assertPositiveInteger(value.generation, 'team-lifecycle-run-generation-invalid');
  return Object.freeze({ runId: parseRunId(value.runId), generation: value.generation });
}

export function parseLifecycleWriterBarrierReceipt(
  value: LifecycleWriterBarrierReceipt,
  expectedTeamId: TeamId
): LifecycleWriterBarrierReceipt {
  if (
    value.schemaVersion !== LIFECYCLE_WRITER_BARRIER_SCHEMA_VERSION ||
    parseTeamId(value.teamId) !== expectedTeamId ||
    !isBoundedIdentifier(value.barrierId, 256)
  ) {
    throw new TypeError('team-lifecycle-writer-barrier-invalid');
  }
  assertNonNegativeInteger(
    value.previousFileWriterEpoch,
    'team-lifecycle-writer-barrier-epoch-invalid'
  );
  assertPositiveInteger(value.nextFileWriterEpoch, 'team-lifecycle-writer-barrier-epoch-invalid');
  if (
    value.nextFileWriterEpoch !== value.previousFileWriterEpoch + 1 ||
    value.drainedThrough.fileWriterEpoch !== value.previousFileWriterEpoch
  ) {
    throw new TypeError('team-lifecycle-writer-barrier-epoch-invalid');
  }
  assertNonNegativeInteger(
    value.drainedThrough.observationSequence,
    'team-lifecycle-writer-watermark-invalid'
  );
  assertCanonicalTimestamp(value.preparedAtIso);
  if (!Object.isFrozen(value) || !Object.isFrozen(value.drainedThrough)) {
    throw new TypeError('team-lifecycle-writer-barrier-must-be-immutable');
  }
  return value;
}

function assertPositiveInteger(value: number, diagnostic: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(diagnostic);
}

function assertNonNegativeInteger(value: number, diagnostic: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(diagnostic);
}

function assertCanonicalTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('team-lifecycle-writer-barrier-timestamp-invalid');
  }
}

function isBoundedIdentifier(value: string, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}
