import {
  type HostedAccessAuthorityPolicy,
  type HostedAuthMode,
  parseAuditEventId,
  parseAuthKeyringId,
  parseHostedSessionId,
  parseHostedWorkspaceId,
  parseOidcLoginAttemptId,
  parseOperatorId,
  parseUserId,
} from '../../../contracts';
import { type HostedAccessAuthorityState, isRecoverableAuthorityState } from '../../../core/domain';

import type {
  AuthorityRepositoryReadResult,
  AuthorityRepositoryWriteResult,
  ExternalIdentityRecord,
  HostedAccessAuthorityRepositoryPort,
  HostedAuditEvent,
  HostedAuthConfiguration,
  HostedAuthModeResetResult,
  HostedIdentityRepositoryPort,
  HostedLocalRoleAssignment,
  HostedOperatorSessionRecord,
  HostedPersonalOwnerRecord,
  HostedRoleSnapshot,
  HostedUserRecord,
  HostedWorkspaceGrant,
  HostedWorkspaceRegistration,
  OidcLoginAttemptRecord,
} from '../../../core/application';
import type { HostedAuthStorageGateway } from '@features/internal-storage/contracts';

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  return value;
}

function numberValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return Number(value);
}

function nullableString(value: unknown, code: string): string | null {
  return value === null ? null : stringValue(value, code);
}

function authConfiguration(value: unknown): HostedAuthConfiguration {
  const row = record(value, 'hosted_auth_configuration_invalid');
  const mode = stringValue(row.authMode, 'hosted_auth_mode_invalid');
  if (mode !== 'personal' && mode !== 'oidc') throw new Error('hosted_auth_mode_invalid');
  const pendingPersonalKeyringId =
    row.pendingPersonalKeyringId === null ? null : parseAuthKeyringId(row.pendingPersonalKeyringId);
  return Object.freeze({
    mode,
    configuredAt: numberValue(row.configuredAt, 'hosted_auth_configured_at_invalid'),
    resetGeneration: numberValue(row.resetGeneration, 'hosted_auth_reset_generation_invalid'),
    secretsRotatedGeneration: numberValue(
      row.secretsRotatedGeneration,
      'hosted_auth_secrets_generation_invalid'
    ),
    pendingPersonalKeyringId,
  });
}

function storageAuditEvent(event: HostedAuditEvent): Record<string, unknown> {
  parseAuditEventId(event.eventId);
  return {
    ...event,
    details: undefined,
    detailsJson: JSON.stringify(event.details),
  };
}

function userRecord(value: unknown): HostedUserRecord {
  const row = record(value, 'hosted_auth_user_row_invalid');
  const status = stringValue(row.status, 'hosted_auth_user_status_invalid');
  if (status !== 'active' && status !== 'disabled') {
    throw new Error('hosted_auth_user_status_invalid');
  }
  return Object.freeze({
    userId: parseUserId(row.userId),
    displayName: stringValue(row.displayName, 'hosted_auth_user_name_invalid'),
    status,
    createdAt: numberValue(row.createdAt, 'hosted_auth_user_created_invalid'),
    updatedAt: numberValue(row.updatedAt, 'hosted_auth_user_updated_invalid'),
  });
}

function localRoleRecord(value: unknown): HostedLocalRoleAssignment {
  const row = record(value, 'hosted_local_role_row_invalid');
  const role = stringValue(row.role, 'hosted_local_role_invalid');
  if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
    throw new Error('hosted_local_role_invalid');
  }
  if (row.assignedBy !== 'local-cli') throw new Error('hosted_local_role_source_invalid');
  return Object.freeze({
    userId: parseUserId(row.userId),
    role: role as HostedLocalRoleAssignment['role'],
    assignedAt: numberValue(row.assignedAt, 'hosted_local_role_assigned_invalid'),
    assignedBy: 'local-cli',
  });
}

function workspaceRecord(value: unknown): HostedWorkspaceRegistration {
  const row = record(value, 'hosted_workspace_row_invalid');
  const status = stringValue(row.status, 'hosted_workspace_status_invalid');
  if (status !== 'active' && status !== 'disabled') {
    throw new Error('hosted_workspace_status_invalid');
  }
  return Object.freeze({
    runtimeWorkspaceId: stringValue(row.runtimeWorkspaceId, 'hosted_runtime_workspace_id_invalid'),
    workspaceId: parseHostedWorkspaceId(row.workspaceId),
    displayName: stringValue(row.displayName, 'hosted_workspace_name_invalid'),
    status,
    registeredAt: numberValue(row.registeredAt, 'hosted_workspace_registered_invalid'),
    registeredBy: row.registeredBy === null ? null : parseUserId(row.registeredBy),
  });
}

function workspaceGrantRecord(value: unknown): HostedWorkspaceGrant {
  const row = record(value, 'hosted_workspace_grant_row_invalid');
  if (row.grantedBy !== 'local-cli') {
    throw new Error('hosted_workspace_grant_source_invalid');
  }
  return Object.freeze({
    userId: parseUserId(row.userId),
    workspaceId: parseHostedWorkspaceId(row.workspaceId),
    runtimeWorkspaceId: stringValue(row.runtimeWorkspaceId, 'hosted_runtime_workspace_id_invalid'),
    displayName: stringValue(row.displayName, 'hosted_workspace_name_invalid'),
    grantGeneration: numberValue(row.grantGeneration, 'hosted_workspace_grant_generation_invalid'),
    grantRevision: stringValue(row.grantRevision, 'hosted_workspace_grant_revision_invalid'),
    grantedAt: numberValue(row.grantedAt, 'hosted_workspace_granted_at_invalid'),
    grantedBy: 'local-cli',
  });
}

function loginAttemptRecord(value: unknown): OidcLoginAttemptRecord {
  const row = record(value, 'oidc_login_attempt_row_invalid');
  return Object.freeze({
    attemptId: parseOidcLoginAttemptId(row.attemptId),
    providerId: stringValue(row.providerId, 'oidc_provider_id_invalid'),
    stateHash: stringValue(row.stateHash, 'oidc_state_hash_invalid'),
    nonce: stringValue(row.nonce, 'oidc_nonce_invalid'),
    pkceVerifierCiphertext: stringValue(row.pkceVerifierCiphertext, 'oidc_pkce_invalid'),
    returnTo: stringValue(row.returnTo, 'oidc_return_to_invalid'),
    createdAt: numberValue(row.createdAt, 'oidc_created_at_invalid'),
    expiresAt: numberValue(row.expiresAt, 'oidc_expires_at_invalid'),
    consumedAt:
      row.consumedAt === null ? null : numberValue(row.consumedAt, 'oidc_consumed_at_invalid'),
  });
}

function sessionRecord(value: unknown): HostedOperatorSessionRecord {
  const row = record(value, 'hosted_session_row_invalid');
  const role = stringValue(row.role, 'hosted_session_role_invalid');
  if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
    throw new Error('hosted_session_role_invalid');
  }
  const source = stringValue(row.roleSource, 'hosted_session_role_source_invalid');
  if (!['personal-owner', 'oidc-claim', 'local-cli'].includes(source)) {
    throw new Error('hosted_session_role_source_invalid');
  }
  const status = stringValue(row.status, 'hosted_session_status_invalid');
  if (status !== 'active' && status !== 'revoked') {
    throw new Error('hosted_session_status_invalid');
  }
  const roleSnapshot: HostedRoleSnapshot = Object.freeze({
    role: role as HostedRoleSnapshot['role'],
    source: source as HostedRoleSnapshot['source'],
    capturedAt: numberValue(row.roleCapturedAt, 'hosted_session_role_captured_invalid'),
  });
  return Object.freeze({
    sessionId: parseHostedSessionId(row.sessionId),
    userId: parseUserId(row.userId),
    secretHash: stringValue(row.secretHash, 'hosted_session_hash_invalid'),
    authenticationMethod: 'oidc',
    providerId: stringValue(row.providerId, 'hosted_session_provider_invalid'),
    providerIssuer: stringValue(row.providerIssuer, 'hosted_session_issuer_invalid'),
    providerSubject: stringValue(row.providerSubject, 'hosted_session_subject_invalid'),
    providerSessionId: nullableString(row.providerSessionId, 'hosted_session_sid_invalid'),
    roleSnapshot,
    issuedAt: numberValue(row.issuedAt, 'hosted_session_issued_invalid'),
    lastUsedAt: numberValue(row.lastUsedAt, 'hosted_session_used_invalid'),
    idleExpiresAt: numberValue(row.idleExpiresAt, 'hosted_session_idle_invalid'),
    absoluteExpiresAt: numberValue(row.absoluteExpiresAt, 'hosted_session_absolute_invalid'),
    status,
    revokedAt:
      row.revokedAt === null ? null : numberValue(row.revokedAt, 'hosted_session_revoked_invalid'),
    revocationReason: nullableString(row.revocationReason, 'hosted_session_reason_invalid'),
  });
}

export class InternalStorageHostedAccessRepository
  implements HostedAccessAuthorityRepositoryPort, HostedIdentityRepositoryPort
{
  constructor(
    private readonly gateway: HostedAuthStorageGateway,
    private readonly authorityPolicy: HostedAccessAuthorityPolicy
  ) {}

  async claimAuthMode(mode: HostedAuthMode, configuredAt: number): Promise<boolean> {
    return (
      (await this.gateway.hostedAuthCall('configuration.claimMode', {
        mode,
        configuredAt,
      })) === true
    );
  }

  async readAuthConfiguration(): Promise<HostedAuthConfiguration | null> {
    const value = await this.gateway.hostedAuthCall('configuration.read', {});
    return value === null ? null : authConfiguration(value);
  }

  async resetAuthMode(input: {
    readonly currentMode: HostedAuthMode;
    readonly targetMode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly resetAt: number;
    readonly expectedAuthorityRevision: number | null;
    readonly nextAuthorityState: HostedAccessAuthorityState;
    readonly pendingPersonalKeyringId: ReturnType<typeof parseAuthKeyringId>;
    readonly auditEvent: HostedAuditEvent;
  }): Promise<HostedAuthModeResetResult> {
    const value = await this.gateway.hostedAuthCall('configuration.resetMode', {
      currentMode: input.currentMode,
      targetMode: input.targetMode,
      resetGeneration: input.resetGeneration,
      resetAt: input.resetAt,
      expectedAuthorityRevision: input.expectedAuthorityRevision,
      nextAuthorityStateJson: JSON.stringify(input.nextAuthorityState),
      pendingPersonalKeyringId: input.pendingPersonalKeyringId,
      auditEvent: storageAuditEvent(input.auditEvent),
    });
    if (
      value !== 'committed' &&
      value !== 'mode_mismatch' &&
      value !== 'generation_not_newer' &&
      value !== 'authority_conflict'
    ) {
      throw new Error('hosted_auth_mode_reset_result_invalid');
    }
    return value;
  }

  async markAuthSecretsRotated(input: {
    readonly mode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly pendingPersonalKeyringId: ReturnType<typeof parseAuthKeyringId>;
  }): Promise<boolean> {
    return (await this.gateway.hostedAuthCall('configuration.markSecretsRotated', input)) === true;
  }

  async load(): Promise<AuthorityRepositoryReadResult> {
    try {
      const value = await this.gateway.hostedAuthCall('authority.load', {});
      if (value === null) return { status: 'empty', rollbackFenceRevision: null };
      const row = record(value, 'hosted_authority_row_invalid');
      const parsed: unknown = JSON.parse(
        stringValue(row.stateJson, 'hosted_authority_state_json_invalid')
      );
      const rollbackFenceRevision = numberValue(
        row.rollbackFenceRevision,
        'hosted_authority_fence_invalid'
      );
      if (
        !isRecoverableAuthorityState(parsed, this.authorityPolicy) ||
        parsed.revision !== numberValue(row.revision, 'hosted_authority_revision_invalid') ||
        parsed.revision !== rollbackFenceRevision
      ) {
        return { status: 'corrupt' };
      }
      return { status: 'available', state: parsed, rollbackFenceRevision };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async initialize(state: HostedAccessAuthorityState): Promise<AuthorityRepositoryWriteResult> {
    try {
      const result = await this.gateway.hostedAuthCall('authority.initialize', {
        stateJson: JSON.stringify(state),
        revision: state.revision,
      });
      return result === 'committed' ? { status: 'committed' } : { status: 'conflict' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly expectedRollbackFenceRevision: number;
    readonly nextState: HostedAccessAuthorityState;
    readonly nextRollbackFenceRevision: number;
  }): Promise<AuthorityRepositoryWriteResult> {
    try {
      const result = await this.gateway.hostedAuthCall('authority.compareAndSwap', {
        expectedRevision: input.expectedRevision,
        expectedRollbackFenceRevision: input.expectedRollbackFenceRevision,
        stateJson: JSON.stringify(input.nextState),
        nextRollbackFenceRevision: input.nextRollbackFenceRevision,
      });
      return result === 'committed' ? { status: 'committed' } : { status: 'conflict' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async createOidcLoginAttempt(
    attempt: OidcLoginAttemptRecord
  ): Promise<'created' | 'conflict' | 'capacity'> {
    const result = await this.gateway.hostedAuthCall('oidcAttempt.create', attempt);
    return result === 'created' || result === 'capacity' ? result : 'conflict';
  }

  async consumeOidcLoginAttempt(input: {
    readonly attemptId: OidcLoginAttemptRecord['attemptId'];
    readonly providerId: string;
    readonly stateHash: string;
    readonly now: number;
  }): Promise<OidcLoginAttemptRecord | null> {
    const value = await this.gateway.hostedAuthCall('oidcAttempt.consume', input);
    return value === null ? null : loginAttemptRecord(value);
  }

  async bindExternalIdentity(input: {
    readonly identity: Omit<ExternalIdentityRecord, 'userId'>;
    readonly proposedUser: HostedUserRecord;
  }): Promise<{ readonly user: HostedUserRecord; readonly identity: ExternalIdentityRecord }> {
    const result = record(
      await this.gateway.hostedAuthCall('identity.bind', input),
      'external_identity_bind_invalid'
    );
    const identity = record(result.identity, 'external_identity_row_invalid');
    return Object.freeze({
      user: userRecord(result.user),
      identity: Object.freeze({
        issuer: stringValue(identity.issuer, 'external_identity_issuer_invalid'),
        subject: stringValue(identity.subject, 'external_identity_subject_invalid'),
        userId: parseUserId(identity.userId),
        providerId: stringValue(identity.providerId, 'external_identity_provider_invalid'),
        createdAt: numberValue(identity.createdAt, 'external_identity_created_invalid'),
        lastAuthenticatedAt: numberValue(
          identity.lastAuthenticatedAt,
          'external_identity_authenticated_invalid'
        ),
      }),
    });
  }

  async ensurePersonalOwner(input: {
    readonly user: HostedUserRecord;
    readonly operatorId: HostedPersonalOwnerRecord['operatorId'];
  }): Promise<HostedPersonalOwnerRecord> {
    const value = record(
      await this.gateway.hostedAuthCall('personal.ensureOwner', input),
      'hosted_personal_owner_row_invalid'
    );
    return Object.freeze({
      operatorId: parseOperatorId(value.operatorId),
      user: userRecord(value.user),
    });
  }

  async createSession(session: HostedOperatorSessionRecord): Promise<void> {
    await this.gateway.hostedAuthCall('session.create', { session });
  }

  async findSessionBySecretHash(secretHash: string): Promise<HostedOperatorSessionRecord | null> {
    const value = await this.gateway.hostedAuthCall('session.findByHash', { secretHash });
    return value === null ? null : sessionRecord(value);
  }

  async touchSession(input: {
    readonly sessionId: HostedOperatorSessionRecord['sessionId'];
    readonly expectedLastUsedAt: number;
    readonly lastUsedAt: number;
    readonly idleExpiresAt: number;
  }): Promise<boolean> {
    return (await this.gateway.hostedAuthCall('session.touch', input)) === true;
  }

  async revokeSession(input: {
    readonly sessionId: HostedOperatorSessionRecord['sessionId'];
    readonly now: number;
    readonly reason: string;
  }): Promise<void> {
    await this.gateway.hostedAuthCall('session.revoke', input);
  }

  async applyBackchannelLogout(input: {
    readonly providerId: string;
    readonly issuer: string;
    readonly subject?: string;
    readonly providerSessionId?: string;
    readonly jti: string;
    readonly expiresAt: number;
    readonly consumedAt: number;
    readonly reason: string;
  }): Promise<{ readonly consumed: boolean; readonly revoked: number }> {
    const value = record(
      await this.gateway.hostedAuthCall('backchannel.apply', input),
      'oidc_backchannel_apply_invalid'
    );
    if (typeof value.consumed !== 'boolean') throw new Error('oidc_backchannel_apply_invalid');
    return Object.freeze({
      consumed: value.consumed,
      revoked: numberValue(value.revoked, 'oidc_backchannel_revoke_count_invalid'),
    });
  }

  async getUser(userId: HostedUserRecord['userId']): Promise<HostedUserRecord | null> {
    const value = await this.gateway.hostedAuthCall('user.get', { userId });
    return value === null ? null : userRecord(value);
  }

  async listUsers(): Promise<readonly HostedUserRecord[]> {
    const value = await this.gateway.hostedAuthCall('user.list', {});
    if (!Array.isArray(value)) throw new Error('hosted_auth_user_list_invalid');
    return Object.freeze(value.map(userRecord));
  }

  async setUserStatus(input: {
    readonly userId: HostedUserRecord['userId'];
    readonly status: HostedUserRecord['status'];
    readonly now: number;
  }): Promise<boolean> {
    return (await this.gateway.hostedAuthCall('user.setStatus', input)) === true;
  }

  async getLocalRoleAssignment(
    userId: HostedUserRecord['userId']
  ): Promise<HostedLocalRoleAssignment | null> {
    const value = await this.gateway.hostedAuthCall('role.getLocal', { userId });
    return value === null ? null : localRoleRecord(value);
  }

  async setLocalRoleAssignment(assignment: HostedLocalRoleAssignment): Promise<void> {
    await this.gateway.hostedAuthCall('role.setLocal', { assignment });
  }

  async clearLocalRoleAssignment(userId: HostedUserRecord['userId']): Promise<boolean> {
    return (await this.gateway.hostedAuthCall('role.clearLocal', { userId })) === true;
  }

  async isWorkspaceRegistered(runtimeWorkspaceId: string): Promise<boolean> {
    return (
      (await this.gateway.hostedAuthCall('workspace.isRegistered', {
        runtimeWorkspaceId,
      })) === true
    );
  }

  async listWorkspaces(): Promise<readonly HostedWorkspaceRegistration[]> {
    const value = await this.gateway.hostedAuthCall('workspace.list', {});
    if (!Array.isArray(value)) throw new Error('hosted_auth_workspace_list_invalid');
    return Object.freeze(value.map(workspaceRecord));
  }

  async registerWorkspace(input: {
    readonly runtimeWorkspaceId: string;
    readonly workspaceId: HostedWorkspaceRegistration['workspaceId'];
    readonly displayName: string;
    readonly registeredAt: number;
    readonly registeredBy: HostedUserRecord['userId'] | null;
  }): Promise<HostedWorkspaceRegistration> {
    return workspaceRecord(await this.gateway.hostedAuthCall('workspace.register', input));
  }

  async disableWorkspace(runtimeWorkspaceId: string): Promise<boolean> {
    return (
      (await this.gateway.hostedAuthCall('workspace.disable', { runtimeWorkspaceId })) === true
    );
  }

  async seedWorkspaces(
    workspaces: readonly {
      readonly runtimeWorkspaceId: string;
      readonly workspaceId: HostedWorkspaceRegistration['workspaceId'];
    }[],
    now: number
  ): Promise<void> {
    for (const workspace of workspaces) {
      await this.gateway.hostedAuthCall('workspace.seed', {
        runtimeWorkspaceId: workspace.runtimeWorkspaceId,
        workspaceId: workspace.workspaceId,
        displayName: workspace.runtimeWorkspaceId,
        registeredAt: now,
      });
    }
  }

  async listWorkspaceGrants(input: {
    readonly userId: HostedWorkspaceGrant['userId'];
    readonly grantGeneration: number;
  }): Promise<readonly HostedWorkspaceGrant[]> {
    const value = await this.gateway.hostedAuthCall('workspace.grant.list', input);
    if (!Array.isArray(value)) throw new Error('hosted_workspace_grant_list_invalid');
    return Object.freeze(value.map(workspaceGrantRecord));
  }

  async grantWorkspace(input: {
    readonly userId: HostedWorkspaceGrant['userId'];
    readonly runtimeWorkspaceId: string;
    readonly grantGeneration: number;
    readonly grantedAt: number;
    readonly grantedBy: 'local-cli';
  }): Promise<HostedWorkspaceGrant> {
    return workspaceGrantRecord(await this.gateway.hostedAuthCall('workspace.grant.set', input));
  }

  async revokeWorkspaceGrant(input: {
    readonly userId: HostedWorkspaceGrant['userId'];
    readonly runtimeWorkspaceId: string;
  }): Promise<boolean> {
    return (await this.gateway.hostedAuthCall('workspace.grant.revoke', input)) === true;
  }

  async appendAudit(event: HostedAuditEvent): Promise<void> {
    await this.gateway.hostedAuthCall('audit.append', {
      event: storageAuditEvent(event),
    });
  }
}
