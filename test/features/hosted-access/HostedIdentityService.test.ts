/* eslint-disable @typescript-eslint/require-await -- In-memory test doubles implement promise-based identity ports synchronously. */

import {
  type HostedAccessAuthority,
  type HostedAuthenticationContext,
  HostedIdentityService,
  HostedLocalAdministration,
  HostedOidcAuthenticationProvider,
  HostedPersonalAuthenticationProvider,
  HostedWorkspaceAccessService,
  parseHostedSessionId,
  parseOidcLoginAttemptId,
  parseUserId,
} from '@features/hosted-access';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import { BINDING } from './authorityFixture';

import type {
  ExternalIdentityRecord,
  HostedAuditEvent,
  HostedIdentityCryptoPort,
  HostedIdentityRepositoryPort,
  HostedLocalRoleAssignment,
  HostedOperatorSessionRecord,
  HostedUserRecord,
  HostedWorkspaceGrant,
  HostedWorkspaceRegistration,
  OidcIdentityProvider,
  OidcLoginAttemptRecord,
} from '@features/hosted-access';

class MemoryRepository implements HostedIdentityRepositoryPort {
  attempts = new Map<string, OidcLoginAttemptRecord>();
  identities = new Map<string, { user: HostedUserRecord; identity: ExternalIdentityRecord }>();
  users = new Map<string, HostedUserRecord>();
  sessions = new Map<string, HostedOperatorSessionRecord>();
  logoutIds = new Set<string>();
  audits: HostedAuditEvent[] = [];
  capacityExceeded = false;
  localRoles = new Map<string, HostedLocalRoleAssignment>();
  workspaces = new Map<string, HostedWorkspaceRegistration>();
  workspaceGrants = new Map<string, HostedWorkspaceGrant>();
  revokeProviderCalls = 0;
  beforeTouchSession: (() => Promise<void>) | null = null;
  beforeListWorkspaces: (() => Promise<void>) | null = null;

  async readAuthConfiguration() {
    return {
      mode: 'oidc' as const,
      configuredAt: 1,
      resetGeneration: 0,
      secretsRotatedGeneration: 0,
      pendingPersonalKeyringId: null,
    };
  }

  async resetAuthMode() {
    return 'authority_conflict' as const;
  }

  async markAuthSecretsRotated() {
    return false;
  }

  async createOidcLoginAttempt(attempt: OidcLoginAttemptRecord) {
    if (this.capacityExceeded) return 'capacity' as const;
    if (this.attempts.has(attempt.attemptId)) return 'conflict' as const;
    this.attempts.set(attempt.attemptId, attempt);
    return 'created' as const;
  }

  async consumeOidcLoginAttempt(input: {
    attemptId: OidcLoginAttemptRecord['attemptId'];
    providerId: string;
    stateHash: string;
    now: number;
  }) {
    const attempt = this.attempts.get(input.attemptId);
    if (attempt === undefined) return null;
    if (
      attempt.consumedAt !== null ||
      attempt.providerId !== input.providerId ||
      attempt.stateHash !== input.stateHash ||
      input.now >= attempt.expiresAt
    ) {
      return null;
    }
    const consumed = { ...attempt, consumedAt: input.now };
    this.attempts.set(input.attemptId, consumed);
    return consumed;
  }

  async bindExternalIdentity(input: {
    identity: Omit<ExternalIdentityRecord, 'userId'>;
    proposedUser: HostedUserRecord;
  }) {
    const key = `${input.identity.issuer}\0${input.identity.subject}`;
    const existing = this.identities.get(key);
    if (existing) return existing;
    const value = {
      user: input.proposedUser,
      identity: { ...input.identity, userId: input.proposedUser.userId },
    };
    this.users.set(value.user.userId, value.user);
    this.identities.set(key, value);
    return value;
  }

  async ensurePersonalOwner(input: {
    user: HostedUserRecord;
    operatorId: Parameters<HostedIdentityRepositoryPort['ensurePersonalOwner']>[0]['operatorId'];
  }) {
    this.users.set(input.user.userId, input.user);
    return { operatorId: input.operatorId, user: input.user };
  }

  async createSession(session: HostedOperatorSessionRecord) {
    this.sessions.set(session.secretHash, session);
  }

  async findSessionBySecretHash(secretHash: string) {
    return this.sessions.get(secretHash) ?? null;
  }

  async touchSession(input: {
    sessionId: HostedOperatorSessionRecord['sessionId'];
    expectedLastUsedAt: number;
    lastUsedAt: number;
    idleExpiresAt: number;
  }) {
    const beforeTouch = this.beforeTouchSession;
    this.beforeTouchSession = null;
    await beforeTouch?.();
    for (const [hash, session] of this.sessions) {
      if (
        session.sessionId === input.sessionId &&
        session.lastUsedAt === input.expectedLastUsedAt &&
        session.status === 'active'
      ) {
        this.sessions.set(hash, {
          ...session,
          lastUsedAt: input.lastUsedAt,
          idleExpiresAt: input.idleExpiresAt,
        });
        return true;
      }
      if (
        session.sessionId === input.sessionId &&
        session.status === 'active' &&
        session.lastUsedAt >= input.expectedLastUsedAt
      ) {
        return true;
      }
    }
    return false;
  }

  async revokeSession(input: {
    sessionId: HostedOperatorSessionRecord['sessionId'];
    now: number;
    reason: string;
  }) {
    for (const [hash, session] of this.sessions) {
      if (session.sessionId === input.sessionId) {
        this.sessions.set(hash, {
          ...session,
          status: 'revoked',
          revokedAt: input.now,
          revocationReason: input.reason,
        });
      }
    }
  }

  async revokeProviderSessions() {
    this.revokeProviderCalls += 1;
    return 1;
  }

  async consumeBackchannelLogoutId(input: { jti: string }) {
    if (this.logoutIds.has(input.jti)) return false;
    this.logoutIds.add(input.jti);
    return true;
  }

  async applyBackchannelLogout(input: { jti: string }) {
    if (!(await this.consumeBackchannelLogoutId(input))) {
      return { consumed: false, revoked: 0 };
    }
    return { consumed: true, revoked: await this.revokeProviderSessions() };
  }

  async getUser(userId: HostedUserRecord['userId']) {
    return this.users.get(userId) ?? null;
  }

  async listUsers() {
    return [...this.users.values()];
  }

  async setUserStatus(input: {
    userId: HostedUserRecord['userId'];
    status: HostedUserRecord['status'];
    now: number;
  }) {
    const user = this.users.get(input.userId);
    if (!user) return false;
    const updated = { ...user, status: input.status, updatedAt: input.now };
    this.users.set(input.userId, updated);
    for (const [key, binding] of this.identities) {
      if (binding.user.userId === input.userId) {
        this.identities.set(key, { ...binding, user: updated });
      }
    }
    if (input.status === 'disabled') {
      for (const [hash, session] of this.sessions) {
        if (session.userId === input.userId && session.status === 'active') {
          this.sessions.set(hash, {
            ...session,
            status: 'revoked',
            revokedAt: input.now,
            revocationReason: 'user_disabled',
          });
        }
      }
    }
    return true;
  }

  async getLocalRoleAssignment(userId: HostedUserRecord['userId']) {
    return this.localRoles.get(userId) ?? null;
  }

  async setLocalRoleAssignment(assignment: HostedLocalRoleAssignment) {
    this.localRoles.set(assignment.userId, assignment);
  }

  async clearLocalRoleAssignment(userId: HostedUserRecord['userId']) {
    return this.localRoles.delete(userId);
  }

  async isWorkspaceRegistered() {
    return true;
  }

  async listWorkspaces() {
    await this.beforeListWorkspaces?.();
    return [...this.workspaces.values()];
  }

  async registerWorkspace(input: {
    runtimeWorkspaceId: string;
    workspaceId: HostedWorkspaceRegistration['workspaceId'];
    displayName: string;
    registeredAt: number;
    registeredBy: HostedUserRecord['userId'] | null;
  }) {
    const value: HostedWorkspaceRegistration = { ...input, status: 'active' };
    this.workspaces.set(input.runtimeWorkspaceId, value);
    return value;
  }

  async disableWorkspace(runtimeWorkspaceId: string) {
    const existing = this.workspaces.get(runtimeWorkspaceId);
    if (!existing || existing.status === 'disabled') return false;
    this.workspaces.set(runtimeWorkspaceId, { ...existing, status: 'disabled' });
    return true;
  }

  async listWorkspaceGrants(input: {
    userId: HostedUserRecord['userId'];
    grantGeneration: number;
  }) {
    return [...this.workspaceGrants.values()].filter(
      (grant) => grant.userId === input.userId && grant.grantGeneration === input.grantGeneration
    );
  }

  async grantWorkspace(input: {
    userId: HostedUserRecord['userId'];
    runtimeWorkspaceId: string;
    grantGeneration: number;
    grantedAt: number;
    grantedBy: 'local-cli';
  }) {
    const workspace = this.workspaces.get(input.runtimeWorkspaceId);
    if (workspace?.status !== 'active') throw new Error('workspace_not_registered');
    const grant: HostedWorkspaceGrant = {
      ...input,
      ...workspace,
      grantRevision: 'a'.repeat(64),
    };
    this.workspaceGrants.set(`${input.userId}\0${input.runtimeWorkspaceId}`, grant);
    return grant;
  }

  async revokeWorkspaceGrant(input: {
    userId: HostedUserRecord['userId'];
    runtimeWorkspaceId: string;
  }) {
    return this.workspaceGrants.delete(`${input.userId}\0${input.runtimeWorkspaceId}`);
  }

  async appendAudit(event: HostedAuditEvent) {
    this.audits.push(event);
  }
}

function harness() {
  let now = 1_000;
  let completeCalls = 0;
  let logoutUnavailable = false;
  let attemptSequence = 0;
  let sessionSequence = 0;
  let secretSequence = 0;
  const repository = new MemoryRepository();
  const crypto: HostedIdentityCryptoPort = {
    randomId: async (kind) => {
      if (kind === 'oidc-attempt') {
        return parseOidcLoginAttemptId(`ola_attempt-123456-${++attemptSequence}`);
      }
      if (kind === 'user') return parseUserId('usr_user-123456789');
      if (kind === 'session') {
        return parseHostedSessionId(`hss_session-123456-${++sessionSequence}`);
      }
      if (kind === 'workspace') return 'workspace_cccccccccccccccccccccccccccccccc';
      return 'aud_event-12345678';
    },
    randomSecret: async () => `session-secret-12345678901234567890-${++secretSequence}`,
    hashSecret: async (purpose, value) => `${purpose}:${value}`,
    deriveCsrf: async (sessionId, secret) => `csrf:${sessionId}:${secret}`,
    encryptLoginSecret: async (value) => `encrypted:${value}`,
    decryptLoginSecret: async (value) => value.replace(/^encrypted:/, ''),
    secureEqual: async (left, right) => left === right,
  };
  const provider: OidcIdentityProvider = {
    id: 'oidc',
    displayName: 'Synthetic IdP',
    beginLogin: async ({ attemptId }) => ({
      redirectUrl: 'https://idp.test/authorize',
      attemptId,
      state: 'state-123456789',
      nonce: 'nonce-123456789',
      pkceVerifier: 'pkce-123456789',
    }),
    completeLogin: async () => {
      completeCalls += 1;
      return {
        issuer: 'https://idp.test',
        subject: 'subject-1',
        displayName: 'First OIDC user',
        // An empty deployment never promotes its first OIDC identity.
        role: 'viewer',
        providerSessionId: 'sid-1',
      };
    },
    logout: async () => {
      if (logoutUnavailable) throw new Error('oidc_provider_unavailable');
      return { redirectUrl: 'https://idp.test/logout' };
    },
    verifyBackchannelLogout: async () => ({
      issuer: 'https://idp.test',
      subject: 'subject-1',
      providerSessionId: 'sid-1',
      jti: 'logout-jti-1',
      expiresAt: now + 1_000,
    }),
  };
  const serviceForRestoreGeneration = (restoreGeneration: number) =>
    new HostedIdentityService({
      repository,
      crypto,
      provider,
      now: () => now,
      policy: {
        oidcLoginTtlMs: 600,
        sessionIdleTtlMs: 100,
        sessionAbsoluteTtlMs: 500,
        restoreGeneration,
      },
    });
  const service = serviceForRestoreGeneration(0);
  const workspaceAccess = new HostedWorkspaceAccessService(repository, 0);
  return {
    service,
    workspaceAccess,
    serviceForRestoreGeneration,
    repository,
    get completeCalls() {
      return completeCalls;
    },
    setNow(value: number) {
      now = value;
    },
    setLogoutUnavailable() {
      logoutUnavailable = true;
    },
  };
}

describe('HostedIdentityService', () => {
  it('suppresses an event when its grant is revoked during workspace projection lookup', async () => {
    const fixture = harness();
    const userId = parseUserId('usr_event-grant-123456');
    const runtimeWorkspaceId = 'project_event-grant';
    const otherRuntimeWorkspaceId = 'project_other-grant';
    for (const [runtimeId, workspaceId] of [
      [runtimeWorkspaceId, 'workspace_cccccccccccccccccccccccccccccccc'],
      [otherRuntimeWorkspaceId, 'workspace_dddddddddddddddddddddddddddddddd'],
    ] as const) {
      fixture.repository.workspaces.set(runtimeId, {
        workspaceId: workspaceId as never,
        runtimeWorkspaceId: runtimeId,
        displayName: runtimeId,
        status: 'active',
        registeredAt: 1,
        registeredBy: null,
      });
      await fixture.repository.grantWorkspace({
        userId,
        runtimeWorkspaceId: runtimeId,
        grantGeneration: 0,
        grantedAt: 2,
        grantedBy: 'local-cli',
      });
    }
    fixture.repository.beforeListWorkspaces = async () => {
      fixture.repository.beforeListWorkspaces = null;
      await fixture.repository.revokeWorkspaceGrant({ userId, runtimeWorkspaceId });
    };

    await expect(
      fixture.workspaceAccess.projectEvent(userId, runtimeWorkspaceId, {
        runtimeWorkspaceId,
        projectPath: '/private/provider/path',
      })
    ).resolves.toBeNull();
    await expect(
      fixture.workspaceAccess.projectWorkspaceId(userId, otherRuntimeWorkspaceId)
    ).resolves.not.toBeNull();
  });

  it('binds owner effects to the exact grant revision and canonical identity checksum', async () => {
    const fixture = harness();
    const userId = parseUserId('usr_grant-fence-123456');
    const runtimeWorkspaceId = 'project_grant-fence';
    const workspaceId = 'workspace_cccccccccccccccccccccccccccccccc' as never;
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    fixture.repository.workspaces.set(runtimeWorkspaceId, {
      workspaceId,
      runtimeWorkspaceId,
      displayName: 'Grant fence workspace',
      status: 'active',
      registeredAt: 1,
      registeredBy: null,
    });
    const granted = await fixture.repository.grantWorkspace({
      userId,
      runtimeWorkspaceId,
      grantGeneration: 0,
      grantedAt: 2,
      grantedBy: 'local-cli',
    });
    let identityChecksum = 'b'.repeat(64);
    const resolveAttribution = async () =>
      Object.freeze({
        kind: 'found' as const,
        runtimeWorkspaceId,
        attributionRevision: 'd'.repeat(64),
        identityChecksum,
      });

    const fence = await fixture.workspaceAccess.captureTeamWorkspaceGrantFence(
      userId,
      teamId,
      resolveAttribution
    );
    expect(fence).toMatchObject({
      grantRevision: 'a'.repeat(64),
      identityChecksum: 'b'.repeat(64),
    });
    if (fence === null) return;
    await expect(
      fixture.workspaceAccess.revalidateTeamWorkspaceGrantFence(fence, resolveAttribution)
    ).resolves.toBe(true);

    identityChecksum = 'e'.repeat(64);
    await expect(
      fixture.workspaceAccess.revalidateTeamWorkspaceGrantFence(fence, resolveAttribution)
    ).resolves.toBe(false);

    identityChecksum = 'b'.repeat(64);
    fixture.repository.workspaceGrants.set(`${userId}\0${runtimeWorkspaceId}`, {
      ...granted,
      grantRevision: 'f'.repeat(64),
    });
    await expect(
      fixture.workspaceAccess.revalidateTeamWorkspaceGrantFence(fence, resolveAttribution)
    ).resolves.toBe(false);
  });

  it('consumes state before exchange, prevents replay and never makes the first OIDC user owner', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/projects/synthetic');
    const complete = () =>
      fixture.service.completeOidcLogin({
        callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
        expectedState: begun.state,
        attemptId: begun.attemptId,
      });
    const issued = await complete();
    expect(issued.principal.role).toBe('viewer');
    expect(issued.principal.userId).toBe('usr_user-123456789');
    expect(issued.returnTo).toBe('/projects/synthetic');
    await expect(complete()).rejects.toThrow('oidc_state_invalid_or_replayed');
    expect(fixture.completeCalls).toBe(1);
  });

  it('does not consume a login attempt when the callback state mismatches its HttpOnly cookie', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    await expect(
      fixture.service.completeOidcLogin({
        callbackUrl: new URL('https://app.test/callback?code=bad&state=attacker-state'),
        expectedState: begun.state,
        attemptId: begun.attemptId,
      })
    ).rejects.toThrow('oidc_state_mismatch');
    await expect(
      fixture.service.completeOidcLogin({
        callbackUrl: new URL(`https://app.test/callback?code=good&state=${begun.state}`),
        expectedState: begun.state,
        attemptId: begun.attemptId,
      })
    ).resolves.toMatchObject({ principal: { role: 'viewer' } });
    expect(fixture.completeCalls).toBe(1);
  });

  it('atomically binds a durable login attempt to the provider that created it', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const attempt = fixture.repository.attempts.get(begun.attemptId)!;
    fixture.repository.attempts.set(begun.attemptId, {
      ...attempt,
      providerId: 'different-provider',
    });

    await expect(
      fixture.service.completeOidcLogin({
        callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
        expectedState: begun.state,
        attemptId: begun.attemptId,
      })
    ).rejects.toThrow('oidc_state_invalid_or_replayed');

    expect(fixture.repository.attempts.get(begun.attemptId)?.consumedAt).toBeNull();
    expect(fixture.completeCalls).toBe(0);
  });

  it('fails closed when the durable OIDC attempt window reaches capacity', async () => {
    const fixture = harness();
    fixture.repository.capacityExceeded = true;
    await expect(fixture.service.beginOidcLogin('/')).rejects.toThrow(
      'oidc_login_capacity_exceeded'
    );
  });

  it('applies a local role assignment only to a fresh reauthentication snapshot', async () => {
    const fixture = harness();
    const firstAttempt = await fixture.service.beginOidcLogin('/');
    const first = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=first&state=${firstAttempt.state}`),
      expectedState: firstAttempt.state,
      attemptId: firstAttempt.attemptId,
    });
    expect(first.principal.role).toBe('viewer');

    const administration = new HostedLocalAdministration({
      mode: 'oidc',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: null,
      identities: fixture.service,
      repository: fixture.repository,
      now: () => 1_001,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: { confirmDrained: async () => ({ status: 'unavailable' }) },
      blockPublicAccess: async () => undefined,
      restorePublicAccess: () => undefined,
      performAuthModeReset: async () => 'authority_conflict',
    });
    await administration.setLocalRole(first.principal.userId, 'owner');
    await expect(administration.listUsers()).resolves.toEqual([
      {
        userId: first.principal.userId,
        displayName: 'First OIDC user',
        status: 'active',
        localRole: 'owner',
      },
    ]);
    const secondAttempt = await fixture.service.beginOidcLogin('/');
    const second = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=second&state=${secondAttempt.state}`),
      expectedState: secondAttempt.state,
      attemptId: secondAttempt.attemptId,
    });

    expect(second.principal.role).toBe('owner');
    expect(second.session.roleSnapshot).toEqual({
      role: 'owner',
      source: 'local-cli',
      capturedAt: 1_000,
    });
    await expect(fixture.service.authenticate(first.sessionSecret)).resolves.toMatchObject({
      authenticated: true,
      principal: { role: 'viewer' },
    });
  });

  it('registers and disables only validated local workspaces', async () => {
    const fixture = harness();
    const administration = new HostedLocalAdministration({
      mode: 'oidc',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: null,
      identities: fixture.service,
      repository: fixture.repository,
      now: () => 1_100,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: { confirmDrained: async () => ({ status: 'unavailable' }) },
      blockPublicAccess: async () => undefined,
      restorePublicAccess: () => undefined,
      performAuthModeReset: async () => 'authority_conflict',
    });

    await expect(
      administration.registerWorkspace('-synthetic-project', 'Synthetic project')
    ).resolves.toMatchObject({
      workspaceId: 'workspace_cccccccccccccccccccccccccccccccc',
      runtimeWorkspaceId: '-synthetic-project',
      displayName: 'Synthetic project',
      status: 'active',
    });
    await expect(administration.disableWorkspace('-synthetic-project')).resolves.toBe(true);
    await expect(administration.disableWorkspace('-synthetic-project')).resolves.toBe(false);
    await expect(administration.registerWorkspace('../escape', 'Escape')).rejects.toThrow(
      'hosted_local_control_workspace_id_invalid'
    );
  });

  it('revokes active sessions and denies reauthentication when a local operator disables a user', async () => {
    const fixture = harness();
    const attempt = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=first&state=${attempt.state}`),
      expectedState: attempt.state,
      attemptId: attempt.attemptId,
    });
    const administration = new HostedLocalAdministration({
      mode: 'oidc',
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      authority: null,
      identities: fixture.service,
      repository: fixture.repository,
      now: () => 1_050,
      runWithBrowserStreamsDrained: (operation) => operation(),
      drainProof: { confirmDrained: async () => ({ status: 'unavailable' }) },
      blockPublicAccess: async () => undefined,
      restorePublicAccess: () => undefined,
      performAuthModeReset: async () => 'authority_conflict',
    });

    await expect(administration.setUserStatus(issued.principal.userId, 'disabled')).resolves.toBe(
      true
    );
    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toEqual({
      authenticated: false,
      reason: 'revoked',
    });
    const retry = await fixture.service.beginOidcLogin('/');
    await expect(
      fixture.service.completeOidcLogin({
        callbackUrl: new URL(`https://app.test/callback?code=retry&state=${retry.state}`),
        expectedState: retry.state,
        attemptId: retry.attemptId,
      })
    ).rejects.toThrow('oidc_user_disabled');
  });

  it('enforces idle and absolute session bounds and derives CSRF from the opaque secret', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
      expectedState: begun.state,
      attemptId: begun.attemptId,
    });
    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toMatchObject({
      authenticated: true,
      csrfToken: `csrf:${issued.session.sessionId}:${issued.sessionSecret}`,
    });
    fixture.setNow(issued.session.absoluteExpiresAt);
    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toEqual({
      authenticated: false,
      reason: 'expired',
    });
  });

  it('lets non-renewing SSE revalidation expire at the original idle deadline', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
      expectedState: begun.state,
      attemptId: begun.attemptId,
    });
    const authentication = new HostedOidcAuthenticationProvider('Synthetic IdP', fixture.service);
    const originalIdleExpiresAt = issued.session.idleExpiresAt;

    fixture.setNow(originalIdleExpiresAt - 1);
    await expect(
      authentication.authenticate({
        sessionSecret: issued.sessionSecret,
        allowRenewal: false,
      })
    ).resolves.toMatchObject({ authenticated: true });
    expect(
      await fixture.repository.findSessionBySecretHash(issued.session.secretHash)
    ).toMatchObject({
      lastUsedAt: issued.session.lastUsedAt,
      idleExpiresAt: originalIdleExpiresAt,
    });

    fixture.setNow(originalIdleExpiresAt);
    await expect(
      authentication.authenticate({
        sessionSecret: issued.sessionSecret,
        allowRenewal: false,
      })
    ).resolves.toEqual({ authenticated: false, reason: 'expired' });
  });

  it('cryptographically invalidates restored OIDC sessions when the restore generation advances', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
      expectedState: begun.state,
      attemptId: begun.attemptId,
    });

    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(
      fixture.serviceForRestoreGeneration(1).authenticate(issued.sessionSecret)
    ).resolves.toEqual({
      authenticated: false,
      reason: 'invalid',
    });
  });

  it('cannot consume an OIDC attempt restored from an older restore generation', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');

    await expect(
      fixture.serviceForRestoreGeneration(1).completeOidcLogin({
        callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
        expectedState: begun.state,
        attemptId: begun.attemptId,
      })
    ).rejects.toThrow('oidc_state_invalid_or_replayed');
    expect(fixture.completeCalls).toBe(0);
    expect(fixture.repository.attempts.get(begun.attemptId)?.consumedAt).toBeNull();
  });

  it('rejects an invalid restore-generation policy before handling credentials', () => {
    const fixture = harness();

    expect(() => fixture.serviceForRestoreGeneration(-1)).toThrow(
      'hosted_identity_restore_generation_invalid'
    );
    expect(() => fixture.serviceForRestoreGeneration(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'hosted_identity_restore_generation_invalid'
    );
  });

  it('normalizes thrown OIDC session-authentication failures as an explicit outage', async () => {
    const fixture = harness();
    fixture.repository.findSessionBySecretHash = async () => {
      throw new Error('synthetic_sqlite_unavailable');
    };
    const authentication = new HostedOidcAuthenticationProvider('Synthetic IdP', fixture.service);

    await expect(
      authentication.authenticate({
        sessionSecret: 'opaque-session-secret',
      })
    ).rejects.toThrow('oidc_authentication_unavailable');
  });

  it('does not report personal logout success when authority revocation was unavailable', async () => {
    const fixture = harness();
    const authority = {
      logout: async () => ({ ok: false, code: 'authority_store_unavailable' }) as const,
    } as unknown as HostedAccessAuthority;
    const authentication = new HostedPersonalAuthenticationProvider(
      BINDING,
      authority,
      fixture.service
    );
    const context: HostedAuthenticationContext = {
      principal: {
        userId: parseUserId('usr_synthetic-personal-owner'),
        displayName: 'Personal owner',
        role: 'owner',
        permissions: [
          'hosted.query',
          'hosted.events',
          'hosted.command',
          'hosted.manage',
          'workspace.manage',
          'identity.manage',
        ],
        authenticationMethod: 'personal',
        sessionId: null,
      },
      sessionSecret: 'abcdefghijklmnopqrstuvwxyz012345',
      csrfToken: 'abcdefghijklmnopqrstuvwxyz012345',
    };

    await expect(authentication.logout({ context })).rejects.toThrow('personal_logout_unavailable');
  });

  it('fails closed when logout revokes the session between lookup and idle-extension CAS', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
      expectedState: begun.state,
      attemptId: begun.attemptId,
    });
    fixture.repository.beforeTouchSession = async () => {
      await fixture.repository.revokeSession({
        sessionId: issued.session.sessionId,
        now: 1_001,
        reason: 'concurrent_logout',
      });
    };

    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toEqual({
      authenticated: false,
      reason: 'revoked',
    });
    expect(
      await fixture.repository.findSessionBySecretHash(issued.session.secretHash)
    ).toMatchObject({
      status: 'revoked',
      revokedAt: 1_001,
      revocationReason: 'concurrent_logout',
      lastUsedAt: issued.session.lastUsedAt,
    });
  });

  it('atomically consumes a back-channel jti with session revocation', async () => {
    const fixture = harness();
    await expect(fixture.service.backchannelLogout('signed-token')).resolves.toBe(1);
    await expect(fixture.service.backchannelLogout('signed-token')).rejects.toThrow(
      'oidc_backchannel_logout_replayed'
    );
    expect(fixture.repository.revokeProviderCalls).toBe(1);
  });

  it('keeps global logout local when the IdP is unavailable and audits the partial failure', async () => {
    const fixture = harness();
    const begun = await fixture.service.beginOidcLogin('/');
    const issued = await fixture.service.completeOidcLogin({
      callbackUrl: new URL(`https://app.test/callback?code=code&state=${begun.state}`),
      expectedState: begun.state,
      attemptId: begun.attemptId,
    });
    fixture.setLogoutUnavailable();

    await expect(
      fixture.service.logout({
        sessionSecret: issued.sessionSecret,
        global: true,
        postLogoutRedirectUri: 'https://app.test',
      })
    ).rejects.toThrow('oidc_provider_unavailable');
    await expect(fixture.service.authenticate(issued.sessionSecret)).resolves.toEqual({
      authenticated: false,
      reason: 'revoked',
    });
    expect(fixture.repository.audits).toContainEqual(
      expect.objectContaining({
        action: 'auth.oidc.global-logout',
        outcome: 'failure',
        details: {
          localSessionRevoked: true,
          reason: 'provider_unavailable',
        },
      })
    );
  });
});
