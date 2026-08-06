import type {
  HostedSavedTeamRequest,
  HostedTeamConfigurationIdempotencyKey,
  HostedTeamConfigurationIdentity,
  HostedTeamConfigurationMember,
  HostedUpdateDraftTeamRequest,
} from '../../contracts/hosted';
import type {
  ActorId,
  QueryContext,
  Revision,
  SafeAppError,
  TeamId,
  WorkspaceId,
} from '@shared/contracts/hosted';

export const HOSTED_TEAM_CONFIGURATION_OPERATIONS = Object.freeze([
  'get_saved_request',
  'create_draft',
  'update_draft',
  'delete_draft',
] as const);

export type HostedTeamConfigurationOperation =
  (typeof HOSTED_TEAM_CONFIGURATION_OPERATIONS)[number];

export type HostedTeamConfigurationAuthorizationScope =
  | Readonly<{ kind: 'workspace'; workspaceId: WorkspaceId }>
  | Readonly<{ kind: 'team'; identity: HostedTeamConfigurationIdentity }>;

export interface HostedTeamConfigurationAuthorizationRequest {
  readonly operation: HostedTeamConfigurationOperation;
  readonly scope: HostedTeamConfigurationAuthorizationScope;
  /** Server-created authenticated context; this value is never accepted from the payload. */
  readonly principal: QueryContext;
}

export type HostedTeamConfigurationAuthorizationResult =
  | Readonly<{
      kind: 'authorized';
      principalId: ActorId;
      scope: HostedTeamConfigurationAuthorizationScope;
    }>
  | Readonly<{ kind: 'denied' }>;

/** Revalidates the authenticated principal and the complete workspace/team grant atomically. */
export interface HostedTeamConfigurationAuthorizationPort {
  authorize(
    request: HostedTeamConfigurationAuthorizationRequest
  ): Promise<HostedTeamConfigurationAuthorizationResult>;
}

export interface HostedTeamConfigurationApplicationError {
  readonly kind: 'error';
  readonly error: SafeAppError;
}

export interface HostedTeamConfigurationApplicationPort {
  createDraft(request: {
    readonly workspaceId: WorkspaceId;
    /**
     * The application atomically binds this key to the workspace, canonical payload, TeamId, and
     * initial revision. An identical replay returns that same TeamId/revision; key reuse with a
     * different canonical payload returns conflict without mutation.
     */
    readonly idempotencyKey: HostedTeamConfigurationIdempotencyKey;
    readonly name: string;
    readonly members: readonly HostedTeamConfigurationMember[];
    readonly context: QueryContext;
  }): Promise<
    | Readonly<{
        kind: 'created';
        teamId: TeamId;
        revision: Revision;
        outcome: 'created' | 'idempotent_replay';
      }>
    | HostedTeamConfigurationApplicationError
  >;
  getSavedRequest(
    identity: HostedTeamConfigurationIdentity,
    context: QueryContext
  ): Promise<
    | Readonly<{ kind: 'found'; draft: HostedSavedTeamRequest }>
    | HostedTeamConfigurationApplicationError
  >;
  updateDraft(
    identity: HostedTeamConfigurationIdentity,
    /** Must be checked atomically; a mismatch returns conflict before any mutation. */
    expectedRevision: Revision,
    updates: HostedUpdateDraftTeamRequest['updates'],
    context: QueryContext
  ): Promise<
    | Readonly<{ kind: 'updated'; draft: HostedSavedTeamRequest }>
    | HostedTeamConfigurationApplicationError
  >;
  deleteDraft(
    identity: HostedTeamConfigurationIdentity,
    /** Must be checked atomically; a mismatch returns conflict before any mutation. */
    expectedRevision: Revision,
    context: QueryContext
  ): Promise<
    | Readonly<{ kind: 'deleted'; outcome: 'deleted' | 'already_absent' }>
    | HostedTeamConfigurationApplicationError
  >;
}
