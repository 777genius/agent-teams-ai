import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createInitialAuthorityState, nextAuthorityState } from '@features/hosted-access';
import { InternalStorageHostedAccessRepository } from '@features/hosted-access/main/adapters/output/InternalStorageHostedAccessRepository';
import { HOSTED_PERSONAL_POLICY } from '@features/hosted-access/main/composition/createHostedAccessFeature';
import { migrateHostedWorkspaceAccess } from '@features/internal-storage/main/infrastructure/worker/internalStorageBackupTables';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedAuthStorageGateway,
  HostedAuthStorageOperation,
} from '@features/internal-storage/contracts';

const directories: string[] = [];
const cores: InternalStorageWorkerCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-auth-storage-'));
  directories.push(directory);
  const databasePath = join(directory, 'internal.sqlite');
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (path, options) => new Database(path, options),
  });
  cores.push(core);
  const gateway: HostedAuthStorageGateway = {
    hostedAuthCall: (operation: HostedAuthStorageOperation, payload: unknown) =>
      Promise.resolve().then(() => core.handle('hostedAuth.call', { operation, payload })),
  };
  return {
    databasePath,
    core,
    gateway,
    repository: new InternalStorageHostedAccessRepository(gateway, HOSTED_PERSONAL_POLICY),
  };
}

function closeCore(core: InternalStorageWorkerCore): void {
  core.close();
  cores.splice(cores.indexOf(core), 1);
}

function reopenRepository(databasePath: string): InternalStorageHostedAccessRepository {
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (path, options) => new Database(path, options),
  });
  cores.push(core);
  return new InternalStorageHostedAccessRepository(
    {
      hostedAuthCall: (operation, payload) =>
        Promise.resolve().then(() => core.handle('hostedAuth.call', { operation, payload })),
    },
    HOSTED_PERSONAL_POLICY
  );
}

describe('hosted auth internal storage', () => {
  it('exposes only auth and coordination-event gateways over one worker lifecycle', () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        '../../../src/features/internal-storage/main/composition/createHostedAuthStorageBackend.ts'
      ),
      'utf8'
    );
    expect(source).toContain('gateway: client');
    expect(source).toContain('coordinationEvents');
    expect(source).toContain('disposal ??= client.close()');
    expect(source).not.toMatch(/taskStallJournalStore|teamIdentityReadBackend|TeamDataService/);
  });

  it('rejects a current-looking workspace schema with weakened metadata', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY);
      CREATE TABLE hosted_workspaces (
        runtime_workspace_id TEXT PRIMARY KEY,
        public_workspace_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        registered_by TEXT
      );
    `);
    expect(() => migrateHostedWorkspaceAccess(database)).toThrow(
      'hosted-workspace-access-migration-metadata-invalid'
    );
    expect(
      database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name = 'hosted_workspace_grants'`
        )
        .get()
    ).toBeUndefined();
    database.close();
  });

  it('accepts a restored current workspace schema with a historical version marker', () => {
    const harness = createHarness();
    expect(harness.core.handle('ping', {})).toMatchObject({ schemaVersion: 19 });
    closeCore(harness.core);

    const restored = new Database(harness.databasePath);
    restored.pragma('user_version = 15');
    restored.close();

    const reopened = new InternalStorageWorkerCore({
      databasePath: harness.databasePath,
      createDatabase: (path, options) => new Database(path, options),
    });
    cores.push(reopened);
    expect(reopened.handle('ping', {})).toMatchObject({ schemaVersion: 19 });

    const verified = new Database(harness.databasePath, { readonly: true });
    expect(
      (
        verified.pragma('table_info(hosted_workspaces)') as {
          readonly name: string;
        }[]
      ).map(({ name }) => name)
    ).toEqual([
      'runtime_workspace_id',
      'public_workspace_id',
      'display_name',
      'status',
      'registered_at',
      'registered_by',
    ]);
    verified.close();
  });

  it('persists the personal authority with a monotonic rollback fence', async () => {
    const harness = createHarness();
    await expect(harness.repository.claimAuthMode('personal', Date.now())).resolves.toBe(true);
    await expect(harness.repository.claimAuthMode('personal', Date.now())).resolves.toBe(true);
    await expect(harness.repository.claimAuthMode('oidc', Date.now())).resolves.toBe(false);
    const initial = createInitialAuthorityState({
      binding: {
        deploymentId: 'deployment_synthetic-1234' as never,
        restoreGeneration: 0,
      },
      keyringId: 'akr_synthetic-1234' as never,
    });
    await expect(harness.repository.initialize(initial)).resolves.toEqual({
      status: 'committed',
    });
    await expect(harness.repository.initialize(initial)).resolves.toEqual({
      status: 'conflict',
    });

    const next = nextAuthorityState(initial, {});
    await expect(
      harness.repository.compareAndSwap({
        expectedRevision: 0,
        expectedRollbackFenceRevision: 0,
        nextState: next,
        nextRollbackFenceRevision: 1,
      })
    ).resolves.toEqual({ status: 'committed' });
    await expect(harness.repository.load()).resolves.toMatchObject({
      status: 'available',
      rollbackFenceRevision: 1,
      state: { revision: 1 },
    });
    await expect(
      harness.gateway.hostedAuthCall('authority.compareAndSwap', {
        expectedRevision: 1,
        expectedRollbackFenceRevision: 1,
        stateJson: JSON.stringify(next),
        nextRollbackFenceRevision: 2,
      })
    ).rejects.toThrow('hosted-auth-authority-revision-mismatch');

    closeCore(harness.core);
    const database = new Database(harness.databasePath);
    expect(database.pragma('user_version', { simple: true })).toBe(19);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'hosted_auth_configuration',
               'hosted_access_authority',
               'users',
               'external_identities',
               'personal_owners',
               'operator_sessions',
               'role_snapshots',
               'local_role_assignments',
               'oidc_login_attempts',
               'oidc_logout_replay',
               'hosted_workspaces',
               'hosted_workspace_grants',
               'auth_audit_events'
             )`
        )
        .get()
    ).toEqual({ count: 13 });
    database
      .prepare(`UPDATE hosted_access_authority SET rollback_fence_revision = 2 WHERE singleton = 1`)
      .run();
    database.close();

    const reopenedRepository = reopenRepository(harness.databasePath);
    await expect(reopenedRepository.load()).resolves.toEqual({ status: 'corrupt' });
  });

  it('atomically consumes OIDC state once and binds issuer/subject to one immutable user', async () => {
    const { repository } = createHarness();
    const attempt = {
      attemptId: 'ola_synthetic-attempt' as never,
      providerId: 'keycloak',
      stateHash: 'hmac-sha256:state',
      nonce: 'nonce',
      pkceVerifierCiphertext: 'v1.nonce.cipher.tag',
      returnTo: '/',
      createdAt: 100,
      expiresAt: 1_000,
      consumedAt: null,
    };
    await expect(repository.createOidcLoginAttempt(attempt)).resolves.toBe('created');
    await expect(
      repository.consumeOidcLoginAttempt({
        attemptId: attempt.attemptId,
        providerId: 'different-provider',
        stateHash: attempt.stateHash,
        now: 199,
      })
    ).resolves.toBeNull();
    await expect(
      repository.consumeOidcLoginAttempt({
        attemptId: attempt.attemptId,
        providerId: attempt.providerId,
        stateHash: attempt.stateHash,
        now: 200,
      })
    ).resolves.toEqual({ ...attempt, consumedAt: 200 });
    await expect(
      repository.consumeOidcLoginAttempt({
        attemptId: attempt.attemptId,
        providerId: attempt.providerId,
        stateHash: attempt.stateHash,
        now: 201,
      })
    ).resolves.toBeNull();

    const first = await repository.bindExternalIdentity({
      identity: {
        issuer: 'https://idp.test',
        subject: 'subject-1',
        providerId: 'keycloak',
        createdAt: 300,
        lastAuthenticatedAt: 300,
      },
      proposedUser: {
        userId: 'usr_first-user-1234' as never,
        displayName: 'First',
        status: 'active',
        createdAt: 300,
        updatedAt: 300,
      },
    });
    const second = await repository.bindExternalIdentity({
      identity: {
        issuer: 'https://idp.test',
        subject: 'subject-1',
        providerId: 'keycloak',
        createdAt: 400,
        lastAuthenticatedAt: 400,
      },
      proposedUser: {
        userId: 'usr_attacker-user-1' as never,
        displayName: 'Replacement',
        status: 'active',
        createdAt: 400,
        updatedAt: 400,
      },
    });
    expect(second.user.userId).toBe(first.user.userId);
    expect(second.user.displayName).toBe('First');
  });

  it('persists local role overrides and registered-workspace administration', async () => {
    const { repository } = createHarness();
    const bound = await repository.bindExternalIdentity({
      identity: {
        issuer: 'https://idp.test',
        subject: 'subject-local-role',
        providerId: 'keycloak',
        createdAt: 100,
        lastAuthenticatedAt: 100,
      },
      proposedUser: {
        userId: 'usr_local-role-1234' as never,
        displayName: 'Local role user',
        status: 'active',
        createdAt: 100,
        updatedAt: 100,
      },
    });
    await repository.setLocalRoleAssignment({
      userId: bound.user.userId,
      role: 'owner',
      assignedAt: 200,
      assignedBy: 'local-cli',
    });
    await expect(repository.getLocalRoleAssignment(bound.user.userId)).resolves.toEqual({
      userId: bound.user.userId,
      role: 'owner',
      assignedAt: 200,
      assignedBy: 'local-cli',
    });
    await expect(repository.listUsers()).resolves.toEqual([bound.user]);
    await expect(
      repository.setUserStatus({
        userId: bound.user.userId,
        status: 'disabled',
        now: 250,
      })
    ).resolves.toBe(true);
    await expect(repository.getUser(bound.user.userId)).resolves.toMatchObject({
      status: 'disabled',
      updatedAt: 250,
    });
    await repository.setUserStatus({
      userId: bound.user.userId,
      status: 'active',
      now: 251,
    });

    await expect(
      repository.registerWorkspace({
        runtimeWorkspaceId: '-synthetic-local-role',
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
        displayName: 'Synthetic local role',
        registeredAt: 300,
        registeredBy: null,
      })
    ).resolves.toMatchObject({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      runtimeWorkspaceId: '-synthetic-local-role',
      status: 'active',
    });
    await expect(repository.isWorkspaceRegistered('-synthetic-local-role')).resolves.toBe(true);
    await expect(repository.disableWorkspace('-synthetic-local-role')).resolves.toBe(true);
    await expect(repository.isWorkspaceRegistered('-synthetic-local-role')).resolves.toBe(false);
    await expect(repository.clearLocalRoleAssignment(bound.user.userId)).resolves.toBe(true);
    await expect(repository.getLocalRoleAssignment(bound.user.userId)).resolves.toBeNull();
  });

  it('default-denies durable per-principal grants across revoke, restart, and restore generation', async () => {
    const harness = createHarness();
    let repository = harness.repository;
    const bindUser = (suffix: string) =>
      repository.bindExternalIdentity({
        identity: {
          issuer: 'https://idp.test',
          subject: `grant-${suffix}`,
          providerId: 'keycloak',
          createdAt: 100,
          lastAuthenticatedAt: 100,
        },
        proposedUser: {
          userId: `usr_workspace-${suffix}-1234` as never,
          displayName: `Workspace ${suffix}`,
          status: 'active' as const,
          createdAt: 100,
          updatedAt: 100,
        },
      });
    const [first, second] = await Promise.all([bindUser('first'), bindUser('second')]);
    await repository.registerWorkspace({
      runtimeWorkspaceId: '-runtime-first',
      workspaceId: 'workspace_11111111111111111111111111111111' as never,
      displayName: 'First workspace',
      registeredAt: 200,
      registeredBy: null,
    });
    await repository.registerWorkspace({
      runtimeWorkspaceId: '-runtime-second',
      workspaceId: 'workspace_22222222222222222222222222222222' as never,
      displayName: 'Second workspace',
      registeredAt: 201,
      registeredBy: null,
    });

    await expect(
      repository.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 0 })
    ).resolves.toEqual([]);
    await repository.grantWorkspace({
      userId: first.user.userId,
      runtimeWorkspaceId: '-runtime-first',
      grantGeneration: 0,
      grantedAt: 300,
      grantedBy: 'local-cli',
    });
    await repository.grantWorkspace({
      userId: second.user.userId,
      runtimeWorkspaceId: '-runtime-second',
      grantGeneration: 0,
      grantedAt: 301,
      grantedBy: 'local-cli',
    });
    await expect(
      repository.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 0 })
    ).resolves.toMatchObject([
      {
        workspaceId: 'workspace_11111111111111111111111111111111',
        runtimeWorkspaceId: '-runtime-first',
      },
    ]);
    await expect(
      repository.listWorkspaceGrants({ userId: second.user.userId, grantGeneration: 0 })
    ).resolves.toMatchObject([
      {
        workspaceId: 'workspace_22222222222222222222222222222222',
        runtimeWorkspaceId: '-runtime-second',
      },
    ]);

    closeCore(harness.core);
    repository = reopenRepository(harness.databasePath);
    await expect(
      repository.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 0 })
    ).resolves.toHaveLength(1);
    await expect(
      repository.revokeWorkspaceGrant({
        userId: first.user.userId,
        runtimeWorkspaceId: '-runtime-first',
      })
    ).resolves.toBe(true);
    await expect(
      repository.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 0 })
    ).resolves.toEqual([]);

    await repository.grantWorkspace({
      userId: first.user.userId,
      runtimeWorkspaceId: '-runtime-first',
      grantGeneration: 0,
      grantedAt: 400,
      grantedBy: 'local-cli',
    });
    const restoredPath = join(dirname(harness.databasePath), 'restored.sqlite');
    const source = new Database(harness.databasePath, { readonly: true });
    await source.backup(restoredPath);
    source.close();
    const restored = reopenRepository(restoredPath);
    await expect(
      restored.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 1 })
    ).resolves.toEqual([]);
    await expect(
      restored.listWorkspaceGrants({ userId: first.user.userId, grantGeneration: 0 })
    ).resolves.toHaveLength(1);
  });

  it('persists role snapshots, workspace admission, audit and logout replay protection', async () => {
    const harness = createHarness();
    let repository = harness.repository;
    const user = await repository.bindExternalIdentity({
      identity: {
        issuer: 'https://idp.test',
        subject: 'subject-1',
        providerId: 'keycloak',
        createdAt: 100,
        lastAuthenticatedAt: 100,
      },
      proposedUser: {
        userId: 'usr_session-user-123' as never,
        displayName: 'Session User',
        status: 'active',
        createdAt: 100,
        updatedAt: 100,
      },
    });
    await repository.createSession({
      sessionId: 'hss_session-record-1' as never,
      userId: user.user.userId,
      secretHash: 'hmac-sha256:session',
      authenticationMethod: 'oidc',
      providerId: 'keycloak',
      providerIssuer: 'https://idp.test',
      providerSubject: 'subject-1',
      providerSessionId: 'sid-1',
      roleSnapshot: { role: 'member', source: 'oidc-claim', capturedAt: 100 },
      issuedAt: 100,
      lastUsedAt: 100,
      idleExpiresAt: 200,
      absoluteExpiresAt: 300,
      status: 'active',
      revokedAt: null,
      revocationReason: null,
    });
    await expect(repository.findSessionBySecretHash('hmac-sha256:session')).resolves.toMatchObject({
      roleSnapshot: { role: 'member', source: 'oidc-claim' },
      status: 'active',
    });
    await expect(
      repository.touchSession({
        sessionId: 'hss_session-record-1' as never,
        expectedLastUsedAt: 100,
        lastUsedAt: 110,
        idleExpiresAt: 210,
      })
    ).resolves.toBe(true);
    await expect(
      repository.touchSession({
        sessionId: 'hss_session-record-1' as never,
        expectedLastUsedAt: 100,
        lastUsedAt: 111,
        idleExpiresAt: 211,
      })
    ).resolves.toBe(true);

    await repository.seedWorkspaces(
      [
        {
          runtimeWorkspaceId: '-synthetic-workspace',
          workspaceId: 'workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as never,
        },
      ],
      100
    );
    await expect(repository.isWorkspaceRegistered('-synthetic-workspace')).resolves.toBe(true);
    await expect(repository.isWorkspaceRegistered('-real-user-project')).resolves.toBe(false);

    const replay = {
      // The operator-facing provider label may change across a restart. The
      // signed issuer, subject and sid remain the security identifiers.
      providerId: 'renamed-keycloak',
      issuer: 'https://idp.test',
      subject: 'subject-1',
      providerSessionId: 'sid-1',
      jti: 'logout-jti-1',
      expiresAt: 1_000,
      consumedAt: 500,
      reason: 'backchannel_logout',
    };
    await expect(repository.applyBackchannelLogout(replay)).resolves.toEqual({
      consumed: true,
      revoked: 1,
    });

    await expect(
      repository.appendAudit({
        eventId: 'aud_synthetic-event-1' as never,
        occurredAt: 500,
        userId: user.user.userId,
        sessionId: 'hss_session-record-1' as never,
        action: 'auth.test',
        outcome: 'success',
        sourceIpHash: null,
        details: { synthetic: true },
      })
    ).resolves.toBeUndefined();

    closeCore(harness.core);
    repository = reopenRepository(harness.databasePath);
    await expect(
      repository.applyBackchannelLogout({
        ...replay,
        providerId: 'renamed-keycloak-again',
      })
    ).resolves.toEqual({ consumed: false, revoked: 0 });
    await expect(repository.findSessionBySecretHash('hmac-sha256:session')).resolves.toMatchObject({
      status: 'revoked',
      revocationReason: 'backchannel_logout',
    });
    await expect(
      repository.touchSession({
        sessionId: 'hss_session-record-1' as never,
        expectedLastUsedAt: 100,
        lastUsedAt: 120,
        idleExpiresAt: 220,
      })
    ).resolves.toBe(false);

    const database = new Database(harness.databasePath, { readonly: true });
    expect(
      database
        .prepare(
          `SELECT event_id AS eventId, action, outcome, details_json AS detailsJson
           FROM auth_audit_events WHERE event_id = ?`
        )
        .get('aud_synthetic-event-1')
    ).toEqual({
      eventId: 'aud_synthetic-event-1',
      action: 'auth.test',
      outcome: 'success',
      detailsJson: '{"synthetic":true}',
    });
    database.close();
  });

  it('atomically resets auth mode, revokes both credential stores and fences secret recovery', async () => {
    const harness = createHarness();
    const { repository } = harness;
    await expect(repository.claimAuthMode('oidc', 100)).resolves.toBe(true);
    await expect(repository.readAuthConfiguration()).resolves.toEqual({
      mode: 'oidc',
      configuredAt: 100,
      resetGeneration: 0,
      secretsRotatedGeneration: 0,
      pendingPersonalKeyringId: null,
    });
    const initial = createInitialAuthorityState({
      binding: {
        deploymentId: 'deployment_mode-reset-1' as never,
        restoreGeneration: 0,
      },
      keyringId: 'akr_before-reset-1' as never,
    });
    await expect(repository.initialize(initial)).resolves.toEqual({ status: 'committed' });
    const binding = await repository.bindExternalIdentity({
      identity: {
        issuer: 'https://idp.test',
        subject: 'mode-reset-subject',
        providerId: 'keycloak',
        createdAt: 100,
        lastAuthenticatedAt: 100,
      },
      proposedUser: {
        userId: 'usr_mode-reset-user-1' as never,
        displayName: 'Mode reset user',
        status: 'active',
        createdAt: 100,
        updatedAt: 100,
      },
    });
    await repository.createSession({
      sessionId: 'hss_mode-reset-session-1' as never,
      userId: binding.user.userId,
      secretHash: 'hmac-sha256:mode-reset-session',
      authenticationMethod: 'oidc',
      providerId: 'keycloak',
      providerIssuer: 'https://idp.test',
      providerSubject: 'mode-reset-subject',
      providerSessionId: 'sid-mode-reset',
      roleSnapshot: { role: 'admin', source: 'oidc-claim', capturedAt: 100 },
      issuedAt: 100,
      lastUsedAt: 100,
      idleExpiresAt: 1_000,
      absoluteExpiresAt: 2_000,
      status: 'active',
      revokedAt: null,
      revocationReason: null,
    });
    const attempt = {
      attemptId: 'ola_mode-reset-attempt-1' as never,
      providerId: 'keycloak',
      stateHash: 'hmac-sha256:mode-reset-state',
      nonce: 'mode-reset-nonce',
      pkceVerifierCiphertext: 'v1.nonce.cipher.tag',
      returnTo: '/',
      createdAt: 100,
      expiresAt: 1_000,
      consumedAt: null,
    };
    await expect(repository.createOidcLoginAttempt(attempt)).resolves.toBe('created');
    const resetState = nextAuthorityState(initial, {
      expectedKeyringId: 'akr_after-reset-1' as never,
      consumedResetGeneration: 1,
    });
    const auditEvent = {
      eventId: 'aud_mode-reset-event-1' as never,
      occurredAt: 500,
      userId: null,
      sessionId: null,
      action: 'auth.local.auth-mode-reset',
      outcome: 'success' as const,
      sourceIpHash: null,
      details: { targetMode: 'personal', resetGeneration: 1 },
    };

    await expect(
      repository.resetAuthMode({
        currentMode: 'oidc',
        targetMode: 'personal',
        resetGeneration: 1,
        resetAt: 500,
        expectedAuthorityRevision: 0,
        nextAuthorityState: resetState,
        pendingPersonalKeyringId: 'akr_after-reset-1' as never,
        auditEvent,
      })
    ).resolves.toBe('committed');
    await expect(repository.readAuthConfiguration()).resolves.toEqual({
      mode: 'personal',
      configuredAt: 500,
      resetGeneration: 1,
      secretsRotatedGeneration: 0,
      pendingPersonalKeyringId: 'akr_after-reset-1',
    });
    await expect(
      repository.findSessionBySecretHash('hmac-sha256:mode-reset-session')
    ).resolves.toMatchObject({
      status: 'revoked',
      revokedAt: 500,
      revocationReason: 'auth_mode_reset',
    });
    await expect(
      repository.consumeOidcLoginAttempt({
        attemptId: attempt.attemptId,
        providerId: attempt.providerId,
        stateHash: attempt.stateHash,
        now: 501,
      })
    ).resolves.toBeNull();
    await expect(repository.load()).resolves.toMatchObject({
      status: 'available',
      rollbackFenceRevision: 1,
      state: {
        revision: 1,
        consumedResetGeneration: 1,
        expectedKeyringId: 'akr_after-reset-1',
        deviceFamilies: [],
        deviceGrants: [],
        sessions: [],
      },
    });
    await expect(
      repository.resetAuthMode({
        currentMode: 'personal',
        targetMode: 'oidc',
        resetGeneration: 1,
        resetAt: 501,
        expectedAuthorityRevision: 1,
        nextAuthorityState: nextAuthorityState(resetState, {
          expectedKeyringId: 'akr_replay-reset-1' as never,
        }),
        pendingPersonalKeyringId: 'akr_replay-reset-1' as never,
        auditEvent: { ...auditEvent, eventId: 'aud_mode-reset-replay-1' as never },
      })
    ).resolves.toBe('generation_not_newer');
    await expect(
      repository.markAuthSecretsRotated({
        mode: 'personal',
        resetGeneration: 1,
        pendingPersonalKeyringId: 'akr_after-reset-1' as never,
      })
    ).resolves.toBe(true);
    await expect(
      repository.markAuthSecretsRotated({
        mode: 'personal',
        resetGeneration: 1,
        pendingPersonalKeyringId: 'akr_after-reset-1' as never,
      })
    ).resolves.toBe(false);
    await expect(repository.claimAuthMode('oidc', 600)).resolves.toBe(false);
    await expect(repository.claimAuthMode('personal', 600)).resolves.toBe(true);

    closeCore(harness.core);
    const reopened = reopenRepository(harness.databasePath);
    await expect(reopened.readAuthConfiguration()).resolves.toEqual({
      mode: 'personal',
      configuredAt: 500,
      resetGeneration: 1,
      secretsRotatedGeneration: 1,
      pendingPersonalKeyringId: null,
    });
  });

  it('rolls back the mode claim and authority fence when the transactional audit append fails', async () => {
    const { repository } = createHarness();
    await repository.claimAuthMode('oidc', 100);
    const initial = createInitialAuthorityState({
      binding: {
        deploymentId: 'deployment_mode-reset-rollback' as never,
        restoreGeneration: 0,
      },
      keyringId: 'akr_mode-reset-rollback' as never,
    });
    await repository.initialize(initial);
    const duplicateAudit = {
      eventId: 'aud_mode-reset-duplicate-1' as never,
      occurredAt: 100,
      userId: null,
      sessionId: null,
      action: 'auth.local.auth-mode-reset',
      outcome: 'success' as const,
      sourceIpHash: null,
      details: { targetMode: 'personal' },
    };
    await repository.appendAudit(duplicateAudit);
    await expect(
      repository.resetAuthMode({
        currentMode: 'oidc',
        targetMode: 'personal',
        resetGeneration: 1,
        resetAt: 200,
        expectedAuthorityRevision: 0,
        nextAuthorityState: nextAuthorityState(initial, {
          expectedKeyringId: 'akr_mode-reset-rollback-next' as never,
          consumedResetGeneration: 1,
        }),
        pendingPersonalKeyringId: 'akr_mode-reset-rollback-next' as never,
        auditEvent: duplicateAudit,
      })
    ).rejects.toThrow();
    await expect(repository.readAuthConfiguration()).resolves.toMatchObject({
      mode: 'oidc',
      resetGeneration: 0,
      secretsRotatedGeneration: 0,
    });
    await expect(repository.load()).resolves.toMatchObject({
      status: 'available',
      rollbackFenceRevision: 0,
      state: { revision: 0, expectedKeyringId: 'akr_mode-reset-rollback' },
    });
  });
});
