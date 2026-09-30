import { HostedAuthModeStorageOps, HostedWorkspaceStorageOps } from './internalStorageBackupTables';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface HostedAuthOperationInput {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(code);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(code);
  }
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(code);
  return Number(value);
}

function nullableText(value: unknown, code: string): string | null {
  return value === null ? null : text(value, code);
}

export class HostedAuthStorageOps {
  private readonly modeOps: HostedAuthModeStorageOps;
  private readonly workspaceOps: HostedWorkspaceStorageOps;

  constructor(private readonly database: () => SqliteDatabase) {
    this.modeOps = new HostedAuthModeStorageOps(database);
    this.workspaceOps = new HostedWorkspaceStorageOps(database);
  }

  handle(inputValue: unknown): unknown {
    const input = record(
      inputValue,
      'hosted-auth-storage-input-invalid'
    ) as unknown as HostedAuthOperationInput;
    const operation = text(input.operation, 'hosted-auth-storage-operation-invalid', 128);
    const payload = record(input.payload, 'hosted-auth-storage-payload-invalid');
    if (operation === 'configuration.read') return this.modeOps.readConfiguration();
    switch (operation) {
      case 'configuration.claimMode':
        return this.claimMode(payload);
      case 'configuration.resetMode':
        return this.modeOps.resetMode(payload);
      case 'configuration.markSecretsRotated':
        return this.modeOps.markSecretsRotated(payload);
      case 'authority.load':
        return this.loadAuthority();
      case 'authority.initialize':
        return this.initializeAuthority(payload);
      case 'authority.compareAndSwap':
        return this.compareAndSwapAuthority(payload);
      case 'oidcAttempt.create':
        return this.createOidcAttempt(payload);
      case 'oidcAttempt.consume':
        return this.consumeOidcAttempt(payload);
      case 'identity.bind':
        return this.bindIdentity(payload);
      case 'personal.ensureOwner':
        return this.ensurePersonalOwner(payload);
      case 'session.create':
        return this.createSession(payload);
      case 'session.findByHash':
        return this.findSessionByHash(payload);
      case 'session.touch':
        return this.touchSession(payload);
      case 'session.revoke':
        return this.revokeSession(payload);
      case 'backchannel.apply':
        return this.applyBackchannelLogout(payload);
      case 'user.get':
        return this.getUser(payload);
      case 'user.list':
        return this.listUsers();
      case 'user.setStatus':
        return this.setUserStatus(payload);
      case 'role.getLocal':
        return this.getLocalRole(payload);
      case 'role.setLocal':
        return this.setLocalRole(payload);
      case 'role.clearLocal':
        return this.clearLocalRole(payload);
      case 'workspace.isRegistered':
        return this.workspaceOps.isWorkspaceRegistered(payload);
      case 'workspace.seed':
        return this.workspaceOps.seedWorkspace(payload);
      case 'workspace.list':
        return this.workspaceOps.listWorkspaces();
      case 'workspace.register':
        return this.workspaceOps.registerWorkspace(payload);
      case 'workspace.disable':
        return this.workspaceOps.disableWorkspace(payload);
      case 'workspace.grant.list':
        return this.workspaceOps.listWorkspaceGrants(payload);
      case 'workspace.grant.set':
        return this.workspaceOps.setWorkspaceGrant(payload);
      case 'workspace.grant.revoke':
        return this.workspaceOps.revokeWorkspaceGrant(payload);
      case 'audit.append':
        return this.appendAudit(payload);
      default:
        throw new Error('hosted-auth-storage-operation-unknown');
    }
  }

  private claimMode(payload: Record<string, unknown>): boolean {
    const mode = text(payload.mode, 'hosted-auth-mode-invalid');
    if (mode !== 'personal' && mode !== 'oidc') throw new TypeError('hosted-auth-mode-invalid');
    return this.database().transaction(() => {
      this.database()
        .prepare(
          `INSERT OR IGNORE INTO hosted_auth_configuration (singleton, auth_mode, configured_at)
           VALUES (1, ?, ?)`
        )
        .run(mode, integer(payload.configuredAt, 'hosted-auth-configured-at-invalid'));
      const row = this.database()
        .prepare(`SELECT auth_mode AS authMode FROM hosted_auth_configuration WHERE singleton = 1`)
        .get() as { authMode?: unknown } | undefined;
      return row?.authMode === mode;
    })();
  }

  private loadAuthority(): unknown {
    return (
      this.database()
        .prepare(
          `SELECT state_json AS stateJson, revision, rollback_fence_revision AS rollbackFenceRevision
           FROM hosted_access_authority WHERE singleton = 1`
        )
        .get() ?? null
    );
  }

  private initializeAuthority(payload: Record<string, unknown>): string {
    const stateJson = text(payload.stateJson, 'hosted-auth-authority-state-invalid', 4_000_000);
    const revision = integer(payload.revision, 'hosted-auth-authority-revision-invalid');
    const parsedState = record(
      JSON.parse(stateJson) as unknown,
      'hosted-auth-authority-state-invalid'
    );
    if (integer(parsedState.revision, 'hosted-auth-authority-revision-invalid') !== revision) {
      throw new TypeError('hosted-auth-authority-revision-mismatch');
    }
    const result = this.database()
      .prepare(
        `INSERT OR IGNORE INTO hosted_access_authority
           (singleton, state_json, revision, rollback_fence_revision)
         VALUES (1, ?, ?, ?)`
      )
      .run(stateJson, revision, revision);
    return result.changes === 1 ? 'committed' : 'conflict';
  }

  private compareAndSwapAuthority(payload: Record<string, unknown>): string {
    const expectedRevision = integer(
      payload.expectedRevision,
      'hosted-auth-authority-expected-revision-invalid'
    );
    const expectedFence = integer(
      payload.expectedRollbackFenceRevision,
      'hosted-auth-authority-fence-invalid'
    );
    const nextRevision = integer(
      payload.nextRollbackFenceRevision,
      'hosted-auth-authority-next-fence-invalid'
    );
    if (nextRevision !== expectedRevision + 1 || nextRevision !== expectedFence + 1) {
      throw new TypeError('hosted-auth-authority-cas-sequence-invalid');
    }
    const stateJson = text(payload.stateJson, 'hosted-auth-authority-state-invalid', 4_000_000);
    const parsedState = record(
      JSON.parse(stateJson) as unknown,
      'hosted-auth-authority-state-invalid'
    );
    if (integer(parsedState.revision, 'hosted-auth-authority-revision-invalid') !== nextRevision) {
      throw new TypeError('hosted-auth-authority-revision-mismatch');
    }
    const result = this.database()
      .prepare(
        `UPDATE hosted_access_authority
         SET state_json = ?, revision = ?, rollback_fence_revision = ?
         WHERE singleton = 1 AND revision = ? AND rollback_fence_revision = ?`
      )
      .run(stateJson, nextRevision, nextRevision, expectedRevision, expectedFence);
    return result.changes === 1 ? 'committed' : 'conflict';
  }

  private createOidcAttempt(payload: Record<string, unknown>): string {
    const createdAt = integer(payload.createdAt, 'oidc-created-at-invalid');
    const expiresAt = integer(payload.expiresAt, 'oidc-expires-at-invalid');
    if (expiresAt <= createdAt) throw new TypeError('oidc-expires-at-invalid');
    return this.database().transaction(() => {
      this.database()
        .prepare(`DELETE FROM oidc_login_attempts WHERE expires_at <= ?`)
        .run(createdAt);
      const retainedAttempts = this.database()
        .prepare(
          `SELECT COUNT(*) AS count FROM oidc_login_attempts
           WHERE expires_at > ?`
        )
        .get(createdAt) as { count: number };
      if (retainedAttempts.count >= 512) return 'capacity';
      const result = this.database()
        .prepare(
          `INSERT OR IGNORE INTO oidc_login_attempts
            (attempt_id, provider_id, state_hash, nonce, pkce_verifier_ciphertext,
             return_to, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          text(payload.attemptId, 'oidc-attempt-id-invalid'),
          text(payload.providerId, 'oidc-provider-id-invalid'),
          text(payload.stateHash, 'oidc-state-hash-invalid'),
          text(payload.nonce, 'oidc-nonce-invalid'),
          text(payload.pkceVerifierCiphertext, 'oidc-pkce-invalid'),
          text(payload.returnTo, 'oidc-return-to-invalid', 2048),
          createdAt,
          expiresAt
        );
      return result.changes === 1 ? 'created' : 'conflict';
    })();
  }

  private consumeOidcAttempt(payload: Record<string, unknown>): unknown {
    const attemptId = text(payload.attemptId, 'oidc-attempt-id-invalid');
    const providerId = text(payload.providerId, 'oidc-provider-id-invalid');
    const stateHash = text(payload.stateHash, 'oidc-state-hash-invalid');
    const now = integer(payload.now, 'oidc-consumed-at-invalid');
    return this.database().transaction(() => {
      const result = this.database()
        .prepare(
          `UPDATE oidc_login_attempts SET consumed_at = ?
           WHERE attempt_id = ? AND provider_id = ? AND state_hash = ?
             AND consumed_at IS NULL AND expires_at > ?`
        )
        .run(now, attemptId, providerId, stateHash, now);
      if (result.changes !== 1) return null;
      return this.database()
        .prepare(
          `SELECT attempt_id AS attemptId, provider_id AS providerId, state_hash AS stateHash,
                  nonce, pkce_verifier_ciphertext AS pkceVerifierCiphertext,
                  return_to AS returnTo, created_at AS createdAt, expires_at AS expiresAt,
                  consumed_at AS consumedAt
           FROM oidc_login_attempts WHERE attempt_id = ?`
        )
        .get(attemptId);
    })();
  }

  private bindIdentity(payload: Record<string, unknown>): unknown {
    const identity = record(payload.identity, 'external-identity-invalid');
    const proposed = record(payload.proposedUser, 'hosted-user-invalid');
    const issuer = text(identity.issuer, 'external-identity-issuer-invalid');
    const subject = text(identity.subject, 'external-identity-subject-invalid');
    return this.database().transaction(() => {
      const existing = this.database()
        .prepare(
          `SELECT u.user_id AS userId, u.display_name AS displayName, u.status,
                  u.created_at AS createdAt, u.updated_at AS updatedAt
           FROM external_identities e JOIN users u ON u.user_id = e.user_id
           WHERE e.issuer = ? AND e.subject = ?`
        )
        .get(issuer, subject) as Record<string, unknown> | undefined;
      if (existing) {
        this.database()
          .prepare(
            `UPDATE external_identities SET last_authenticated_at = ?
             WHERE issuer = ? AND subject = ?`
          )
          .run(
            integer(identity.lastAuthenticatedAt, 'external-identity-auth-at-invalid'),
            issuer,
            subject
          );
        return {
          user: existing,
          identity: {
            ...identity,
            issuer,
            subject,
            userId: existing.userId,
          },
        };
      }
      this.database()
        .prepare(
          `INSERT INTO users (user_id, display_name, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          text(proposed.userId, 'hosted-user-id-invalid'),
          text(proposed.displayName, 'hosted-user-display-name-invalid', 256),
          text(proposed.status, 'hosted-user-status-invalid'),
          integer(proposed.createdAt, 'hosted-user-created-at-invalid'),
          integer(proposed.updatedAt, 'hosted-user-updated-at-invalid')
        );
      this.database()
        .prepare(
          `INSERT INTO external_identities
           (issuer, subject, user_id, provider_id, created_at, last_authenticated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          issuer,
          subject,
          proposed.userId,
          text(identity.providerId, 'oidc-provider-id-invalid'),
          integer(identity.createdAt, 'external-identity-created-at-invalid'),
          integer(identity.lastAuthenticatedAt, 'external-identity-auth-at-invalid')
        );
      return {
        user: proposed,
        identity: { ...identity, issuer, subject, userId: proposed.userId },
      };
    })();
  }

  private ensurePersonalOwner(payload: Record<string, unknown>): unknown {
    const user = record(payload.user, 'hosted-user-invalid');
    const operatorId = text(payload.operatorId, 'personal-operator-id-invalid');
    return this.database().transaction(() => {
      const existing = this.database()
        .prepare(
          `SELECT p.operator_id AS operatorId, u.user_id AS userId,
                  u.display_name AS displayName, u.status,
                  u.created_at AS createdAt, u.updated_at AS updatedAt
           FROM personal_owners p JOIN users u ON u.user_id = p.user_id WHERE p.singleton = 1`
        )
        .get() as Record<string, unknown> | undefined;
      if (existing) {
        return {
          operatorId: existing.operatorId,
          user: {
            userId: existing.userId,
            displayName: existing.displayName,
            status: existing.status,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          },
        };
      }
      this.database()
        .prepare(
          `INSERT INTO users (user_id, display_name, status, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?)`
        )
        .run(
          text(user.userId, 'hosted-user-id-invalid'),
          text(user.displayName, 'hosted-user-display-name-invalid', 256),
          integer(user.createdAt, 'hosted-user-created-at-invalid'),
          integer(user.updatedAt, 'hosted-user-updated-at-invalid')
        );
      this.database()
        .prepare(
          `INSERT INTO personal_owners (singleton, operator_id, user_id, created_at)
           VALUES (1, ?, ?, ?)`
        )
        .run(operatorId, user.userId, user.createdAt);
      return { operatorId, user };
    })();
  }

  private createSession(payload: Record<string, unknown>): null {
    const session = record(payload.session, 'hosted-session-invalid');
    this.database().transaction(() => {
      this.database()
        .prepare(
          `INSERT INTO operator_sessions
           (session_id, user_id, secret_hash, authentication_method, provider_id,
            provider_issuer, provider_subject, provider_session_id, issued_at, last_used_at,
            idle_expires_at, absolute_expires_at, status, revoked_at, revocation_reason)
           VALUES (?, ?, ?, 'oidc', ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`
        )
        .run(
          text(session.sessionId, 'hosted-session-id-invalid'),
          text(session.userId, 'hosted-user-id-invalid'),
          text(session.secretHash, 'hosted-session-secret-hash-invalid'),
          text(session.providerId, 'oidc-provider-id-invalid'),
          text(session.providerIssuer, 'oidc-provider-issuer-invalid'),
          text(session.providerSubject, 'oidc-provider-subject-invalid'),
          nullableText(session.providerSessionId, 'oidc-provider-session-invalid'),
          integer(session.issuedAt, 'hosted-session-issued-at-invalid'),
          integer(session.lastUsedAt, 'hosted-session-last-used-at-invalid'),
          integer(session.idleExpiresAt, 'hosted-session-idle-invalid'),
          integer(session.absoluteExpiresAt, 'hosted-session-absolute-invalid')
        );
      const snapshot = record(session.roleSnapshot, 'hosted-role-snapshot-invalid');
      this.database()
        .prepare(
          `INSERT INTO role_snapshots (session_id, role, source, captured_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          session.sessionId,
          text(snapshot.role, 'hosted-role-invalid'),
          text(snapshot.source, 'hosted-role-source-invalid'),
          integer(snapshot.capturedAt, 'hosted-role-captured-at-invalid')
        );
    })();
    return null;
  }

  private findSessionByHash(payload: Record<string, unknown>): unknown {
    return (
      this.database()
        .prepare(
          `SELECT s.session_id AS sessionId, s.user_id AS userId, s.secret_hash AS secretHash,
                  s.authentication_method AS authenticationMethod, s.provider_id AS providerId,
                  s.provider_issuer AS providerIssuer, s.provider_subject AS providerSubject,
                  s.provider_session_id AS providerSessionId, s.issued_at AS issuedAt,
                  s.last_used_at AS lastUsedAt, s.idle_expires_at AS idleExpiresAt,
                  s.absolute_expires_at AS absoluteExpiresAt, s.status, s.revoked_at AS revokedAt,
                  s.revocation_reason AS revocationReason, r.role, r.source AS roleSource,
                  r.captured_at AS roleCapturedAt
           FROM operator_sessions s JOIN role_snapshots r ON r.session_id = s.session_id
           WHERE s.secret_hash = ?`
        )
        .get(text(payload.secretHash, 'hosted-session-secret-hash-invalid')) ?? null
    );
  }

  private touchSession(payload: Record<string, unknown>): boolean {
    const lastUsedAt = integer(payload.lastUsedAt, 'hosted-session-last-used-at-invalid');
    const idleExpiresAt = integer(payload.idleExpiresAt, 'hosted-session-idle-invalid');
    const sessionId = text(payload.sessionId, 'hosted-session-id-invalid');
    const expectedLastUsedAt = integer(
      payload.expectedLastUsedAt,
      'hosted-session-expected-last-used-invalid'
    );
    return this.database().transaction(() => {
      const result = this.database()
        .prepare(
          `UPDATE operator_sessions SET last_used_at = ?, idle_expires_at = ?
           WHERE session_id = ? AND last_used_at = ? AND status = 'active'`
        )
        .run(lastUsedAt, idleExpiresAt, sessionId, expectedLastUsedAt);
      if (result.changes === 1) return true;

      // Parallel requests may both authenticate the same still-active bearer
      // from one snapshot. A newer successful touch is admissible; logout,
      // user disable, back-channel revocation, and expiry all change status
      // first and therefore remain fail closed.
      const current = this.database()
        .prepare(
          `SELECT status, last_used_at AS lastUsedAt
           FROM operator_sessions WHERE session_id = ?`
        )
        .get(sessionId) as { readonly status?: unknown; readonly lastUsedAt?: unknown } | undefined;
      return (
        current?.status === 'active' &&
        typeof current.lastUsedAt === 'number' &&
        current.lastUsedAt >= expectedLastUsedAt
      );
    })();
  }

  private revokeSession(payload: Record<string, unknown>): null {
    this.database()
      .prepare(
        `UPDATE operator_sessions SET status = 'revoked', revoked_at = ?, revocation_reason = ?
         WHERE session_id = ? AND status = 'active'`
      )
      .run(
        integer(payload.now, 'hosted-session-revoked-at-invalid'),
        text(payload.reason, 'hosted-session-reason-invalid', 256),
        text(payload.sessionId, 'hosted-session-id-invalid')
      );
    return null;
  }

  private revokeProviderSessions(payload: Record<string, unknown>): number {
    const subject =
      payload.subject === undefined ? null : text(payload.subject, 'oidc-sub-invalid');
    const sid =
      payload.providerSessionId === undefined
        ? null
        : text(payload.providerSessionId, 'oidc-sid-invalid');
    if (subject === null && sid === null) throw new TypeError('oidc-logout-selector-invalid');
    const result = this.database()
      .prepare(
        `UPDATE operator_sessions SET status = 'revoked', revoked_at = ?, revocation_reason = ?
         WHERE status = 'active' AND provider_issuer = ?
           AND (? IS NULL OR provider_subject = ?) AND (? IS NULL OR provider_session_id = ?)`
      )
      .run(
        integer(payload.now, 'hosted-session-revoked-at-invalid'),
        text(payload.reason, 'hosted-session-reason-invalid', 256),
        text(payload.issuer, 'oidc-issuer-invalid'),
        subject,
        subject,
        sid,
        sid
      );
    return result.changes;
  }

  private consumeBackchannelId(payload: Record<string, unknown>): boolean {
    const db = this.database();
    const consumedAt = integer(payload.consumedAt, 'oidc-logout-consumed-at-invalid');
    const expiresAt = integer(payload.expiresAt, 'oidc-logout-expires-at-invalid');
    if (expiresAt <= consumedAt || expiresAt > consumedAt + 25 * 60 * 60 * 1_000) {
      throw new TypeError('oidc-logout-expires-at-invalid');
    }
    db.prepare(`DELETE FROM oidc_logout_replay WHERE expires_at <= ?`).run(consumedAt);
    const issuer = text(payload.issuer, 'oidc-issuer-invalid');
    const jti = text(payload.jti, 'oidc-jti-invalid');
    const replayed = db
      .prepare(`SELECT 1 FROM oidc_logout_replay WHERE issuer = ? AND jti = ?`)
      .get(issuer, jti);
    if (replayed !== undefined) return false;
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO oidc_logout_replay
         (provider_id, issuer, jti, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        text(payload.providerId, 'oidc-provider-id-invalid'),
        issuer,
        jti,
        expiresAt,
        consumedAt
      );
    return result.changes === 1;
  }

  private applyBackchannelLogout(payload: Record<string, unknown>): unknown {
    return this.database().transaction(() => {
      const consumed = this.consumeBackchannelId(payload);
      if (!consumed) return { consumed: false, revoked: 0 };
      return {
        consumed: true,
        revoked: this.revokeProviderSessions({
          ...payload,
          now: payload.consumedAt,
        }),
      };
    })();
  }

  private getUser(payload: Record<string, unknown>): unknown {
    return (
      this.database()
        .prepare(
          `SELECT user_id AS userId, display_name AS displayName, status,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM users WHERE user_id = ?`
        )
        .get(text(payload.userId, 'hosted-user-id-invalid')) ?? null
    );
  }

  private listUsers(): unknown {
    return this.database()
      .prepare(
        `SELECT user_id AS userId, display_name AS displayName, status,
                created_at AS createdAt, updated_at AS updatedAt
         FROM users ORDER BY created_at, user_id`
      )
      .all();
  }

  private setUserStatus(payload: Record<string, unknown>): boolean {
    const userId = text(payload.userId, 'hosted-user-id-invalid');
    const status = text(payload.status, 'hosted-user-status-invalid');
    if (status !== 'active' && status !== 'disabled') {
      throw new TypeError('hosted-user-status-invalid');
    }
    const now = integer(payload.now, 'hosted-user-updated-at-invalid');
    return this.database().transaction(() => {
      const result = this.database()
        .prepare(`UPDATE users SET status = ?, updated_at = ? WHERE user_id = ?`)
        .run(status, now, userId);
      if (result.changes !== 1) return false;
      if (status === 'disabled') {
        this.database()
          .prepare(
            `UPDATE operator_sessions
             SET status = 'revoked', revoked_at = ?, revocation_reason = 'user_disabled'
             WHERE user_id = ? AND status = 'active'`
          )
          .run(now, userId);
      }
      return true;
    })();
  }

  private getLocalRole(payload: Record<string, unknown>): unknown {
    return (
      this.database()
        .prepare(
          `SELECT user_id AS userId, role, assigned_at AS assignedAt, assigned_by AS assignedBy
           FROM local_role_assignments WHERE user_id = ?`
        )
        .get(text(payload.userId, 'hosted-user-id-invalid')) ?? null
    );
  }

  private setLocalRole(payload: Record<string, unknown>): null {
    const assignment = record(payload.assignment, 'hosted-local-role-assignment-invalid');
    const role = text(assignment.role, 'hosted-role-invalid');
    if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
      throw new TypeError('hosted-role-invalid');
    }
    const assignedBy = text(assignment.assignedBy, 'hosted-role-assigned-by-invalid');
    if (assignedBy !== 'local-cli') throw new TypeError('hosted-role-assigned-by-invalid');
    this.database()
      .prepare(
        `INSERT INTO local_role_assignments (user_id, role, assigned_at, assigned_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           role = excluded.role,
           assigned_at = excluded.assigned_at,
           assigned_by = excluded.assigned_by`
      )
      .run(
        text(assignment.userId, 'hosted-user-id-invalid'),
        role,
        integer(assignment.assignedAt, 'hosted-role-assigned-at-invalid'),
        assignedBy
      );
    return null;
  }

  private clearLocalRole(payload: Record<string, unknown>): boolean {
    return (
      this.database()
        .prepare(`DELETE FROM local_role_assignments WHERE user_id = ?`)
        .run(text(payload.userId, 'hosted-user-id-invalid')).changes === 1
    );
  }

  private appendAudit(payload: Record<string, unknown>): null {
    const event = record(payload.event, 'hosted-audit-event-invalid');
    const outcome = text(event.outcome, 'hosted-audit-outcome-invalid');
    if (outcome !== 'success' && outcome !== 'denied' && outcome !== 'failure') {
      throw new TypeError('hosted-audit-outcome-invalid');
    }
    this.database()
      .prepare(
        `INSERT INTO auth_audit_events
         (event_id, occurred_at, user_id, session_id, action, outcome, source_ip_hash, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        text(event.eventId, 'hosted-audit-id-invalid'),
        integer(event.occurredAt, 'hosted-audit-occurred-at-invalid'),
        nullableText(event.userId, 'hosted-user-id-invalid'),
        nullableText(event.sessionId, 'hosted-session-id-invalid'),
        text(event.action, 'hosted-audit-action-invalid', 256),
        outcome,
        nullableText(event.sourceIpHash, 'hosted-audit-source-ip-invalid'),
        text(event.detailsJson, 'hosted-audit-details-invalid', 65_536)
      );
    return null;
  }
}
