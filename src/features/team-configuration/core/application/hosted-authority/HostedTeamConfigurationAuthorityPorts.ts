import type {
  HostedSavedTeamRequest,
  HostedTeamConfigurationIdempotencyKey,
  HostedTeamConfigurationIdentity,
  HostedTeamConfigurationMember,
  HostedUpdateDraftTeamRequest,
} from '../../../contracts/hosted';
import type { QueryContext, Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export type HostedTeamConfigurationStorageCreateResult =
  | Readonly<{
      kind: 'created';
      teamId: TeamId;
      revision: Revision;
      outcome: 'created' | 'idempotent_replay';
    }>
  | Readonly<{ kind: 'conflict'; reason: 'idempotency_mismatch' }>;

export type HostedTeamConfigurationStorageReadResult =
  | Readonly<{ kind: 'found'; draft: HostedSavedTeamRequest }>
  | Readonly<{ kind: 'not_found' }>;

export type HostedTeamConfigurationStorageUpdateResult =
  | Readonly<{ kind: 'updated'; draft: HostedSavedTeamRequest }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; reason: 'revision_mismatch' }>;

export type HostedTeamConfigurationStorageDeleteResult =
  | Readonly<{ kind: 'deleted'; outcome: 'deleted' | 'already_absent' }>
  | Readonly<{ kind: 'conflict'; reason: 'revision_mismatch' }>;

/** Application-owned persistence boundary; adapters may not own application policy. */
export interface HostedTeamConfigurationAuthorityStoragePort {
  create(
    request: {
      readonly workspaceId: WorkspaceId;
      readonly idempotencyKey: HostedTeamConfigurationIdempotencyKey;
      readonly payloadHash: string;
      readonly metadata: Readonly<{ name: string }>;
      readonly members: readonly HostedTeamConfigurationMember[];
      readonly deadlineAtMs: number;
    },
    signal: AbortSignal
  ): Promise<HostedTeamConfigurationStorageCreateResult>;
  read(
    identity: HostedTeamConfigurationIdentity
  ): Promise<HostedTeamConfigurationStorageReadResult>;
  update(
    request: HostedTeamConfigurationIdentity & {
      readonly expectedRevision: Revision;
      readonly updates: HostedUpdateDraftTeamRequest['updates'];
      readonly deadlineAtMs: number;
    },
    signal: AbortSignal
  ): Promise<HostedTeamConfigurationStorageUpdateResult>;
  delete(
    request: HostedTeamConfigurationIdentity & {
      readonly expectedRevision: Revision;
      readonly deadlineAtMs: number;
    },
    signal: AbortSignal
  ): Promise<HostedTeamConfigurationStorageDeleteResult>;
}

export interface HostedTeamConfigurationAuthorityDependencies {
  readonly storage: HostedTeamConfigurationAuthorityStoragePort;
  readonly sha256Hex: (canonicalPayload: string) => Promise<string> | string;
  readonly now: () => number;
}

export interface HostedTeamConfigurationAuthorityCreateRequest {
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: HostedTeamConfigurationIdempotencyKey;
  readonly name: string;
  readonly members: readonly HostedTeamConfigurationMember[];
  readonly context: QueryContext;
}
