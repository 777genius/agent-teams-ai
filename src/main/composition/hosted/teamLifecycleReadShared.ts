import { createHash } from 'node:crypto';

import { type TeamIdentityRecord } from '@features/internal-storage/contracts';
import { type RuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import {
  type LegacyTeamIdentityBinding,
  type LegacyTeamReadAvailability,
} from '@features/team-lifecycle/main';
import {
  type ActorId,
  type AuthorizedScope,
  type BootId,
  createSafeAppError,
  type DeploymentId,
  parseRevision,
  type Revision,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import type { WorkspaceMountBinding } from '@features/workspace-registry';

export const MAX_PAGE_SIZE = 1_000;
export const MAX_LEGACY_SUMMARIES = 2_000;
export const TEAM_LIFECYCLE_READ_CURSOR_PREFIX = 'cursor_team_lifecycle_read';
const TEAM_LIFECYCLE_READ_CURSOR_PATTERN = /^cursor_team_lifecycle_read_(\d+)_([0-9a-f]{64})$/;
const COMPATIBILITY_CURSOR_READ_PATTERN = /^cursor_phase2_(\d+)_([0-9a-f]{64})$/;
export const TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS = Object.freeze({
  identityCorrupt: 'team-lifecycle-read.identity-corrupt',
  dataCorrupt: 'team-lifecycle-read.data-corrupt',
  clockInvalid: 'team-lifecycle-read.clock-invalid',
  projectionPurposeInvalid: 'team-lifecycle-read.projection-purpose-invalid',
  hostUnexpected: 'team-lifecycle-read.host-unexpected',
  requestErrorInvalid: 'team-lifecycle-read.request-error-invalid',
});

export interface TeamLifecycleReadAuthority {
  readonly actorId: ActorId;
  readonly authorizedScope: AuthorizedScope;
  readonly workspaceId: WorkspaceId;
  readonly workspaceGeneration: number;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
}

export interface TeamLifecycleReadAuthorityInput {
  readonly actorId: unknown;
  readonly authorizedScope: unknown;
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
}

export interface FrozenLegacyLifecycleSummary extends Readonly<Record<PropertyKey, unknown>> {
  readonly teamName: string;
}

export interface TeamLifecycleReadSnapshot {
  readonly identities: readonly TeamIdentityRecord[];
  readonly summaries: readonly FrozenLegacyLifecycleSummary[];
  readonly summariesByName: ReadonlyMap<string, FrozenLegacyLifecycleSummary>;
  readonly revision: Revision;
}

export interface FrozenRuntimeState {
  readonly teamName: string;
  readonly isAlive: boolean;
}

export type IdentityProjectionPurpose = 'lifecycle' | 'runtime';

/** Reads stable cursors and the compatibility wire form; cursor writes stay stable-only. */
export function matchTeamLifecycleReadCursorForRead(value: string): RegExpExecArray | null {
  return (
    TEAM_LIFECYCLE_READ_CURSOR_PATTERN.exec(value) ?? COMPATIBILITY_CURSOR_READ_PATTERN.exec(value)
  );
}

export function failure(
  code: TeamLifecycleReadFailure['error']['code'],
  reason: string,
  diagnosticId?: string
): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code, reason, diagnosticId });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: code === 'unavailable',
  });
}

export function corruptIdentity(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.identityCorrupt);
}

export function corruptData(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.dataCorrupt);
}

export function identityUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'identity_storage_unavailable');
}

export function dataUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'source_unavailable');
}

export function forbiddenContext(): TeamLifecycleReadFailure {
  return failure('forbidden', 'scope_not_authorized');
}

export function cancelledContext(
  reason: 'request_cancelled' | 'deadline_exceeded'
): TeamLifecycleReadFailure {
  return failure('cancelled', reason);
}

export function clockInvalid(): TeamLifecycleReadFailure {
  return failure('internal', 'policy_failure', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.clockInvalid);
}

export function snapshotChanged(): TeamLifecycleReadFailure {
  return failure('conflict', 'snapshot_changed');
}

export function invalidCursor(): TeamLifecycleReadFailure {
  return failure('invalid_request', 'cursor_invalid');
}

export function projectionPurposeInvalid(): TeamLifecycleReadFailure {
  return failure(
    'internal',
    'unexpected',
    TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.projectionPurposeInvalid
  );
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function projectedRevision(identity: TeamIdentityRecord, projection: unknown): Revision {
  return parseRevision(`revision_${digest({ identity, projection })}`);
}

export function availability(
  identity: TeamIdentityRecord,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamReadAvailability {
  switch (identity.state) {
    case 'reserved':
      return 'draft';
    case 'adoption_prepared':
    case 'file_published':
      return 'provisioning';
    case 'active':
      return summary?.pendingCreate === true ? 'draft' : 'current';
    case 'tombstoned':
      return 'current';
  }
}

export function binding(
  identity: TeamIdentityRecord,
  projection: unknown,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamIdentityBinding | TeamLifecycleReadFailure {
  if (identity.workspaceBinding === null) return corruptIdentity();
  return Object.freeze({
    workspaceId: identity.workspaceBinding.workspaceId,
    teamId: identity.teamId,
    legacyTeamName: identity.legacyKey,
    displayName: identity.legacyKey,
    revision: projectedRevision(identity, projection),
    availability: availability(identity, summary),
  });
}

export function isFailure(
  value: LegacyTeamIdentityBinding | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value && value.kind === 'failure';
}

export function isSnapshotFailure(
  value: TeamLifecycleReadSnapshot | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

export function isRuntimeFailure(
  value: FrozenRuntimeState | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

export function isAliveNamesFailure(
  value: readonly string[] | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return !Array.isArray(value);
}

export function authorityCursorDigest(
  authority: TeamLifecycleReadAuthority,
  revision: Revision,
  offset: number
): string {
  return digest({
    snapshotRevision: revision,
    actorId: authority.actorId,
    authorizedScope: authority.authorizedScope,
    workspaceId: authority.workspaceId,
    workspaceGeneration: authority.workspaceGeneration,
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    offset,
  });
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectSummary(
  legacyTeamName: string,
  value: Record<PropertyKey, unknown>
): FrozenLegacyLifecycleSummary {
  const summary: Record<string, unknown> = { teamName: legacyTeamName };
  if (typeof value.deletedAt === 'string') summary.deletedAt = value.deletedAt;
  if (value.pendingCreate === true) summary.pendingCreate = true;
  if (value.partialLaunchFailure === true) summary.partialLaunchFailure = true;
  return Object.freeze(summary) as FrozenLegacyLifecycleSummary;
}

export function tombstoneSummary(identity: TeamIdentityRecord): FrozenLegacyLifecycleSummary {
  return Object.freeze({
    teamName: identity.legacyKey,
    deletedAt: identity.tombstonedAt,
  });
}
