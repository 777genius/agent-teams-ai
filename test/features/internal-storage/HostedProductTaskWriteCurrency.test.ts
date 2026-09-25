import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseUserId } from '@features/hosted-access/contracts';
import { NodeHostedQueryContextIdentity } from '@features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { createHostedTaskAssignmentCurrentWorkerClient } from '@features/internal-storage/main/infrastructure/HostedTaskAssignmentCurrentWorkerClient';
import { createHostedPromotionCommitAuthority } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionCommitAuthority';
import { isInternalStorageMutation } from '@features/internal-storage/main/infrastructure/worker/internalStorageMutationClassification';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import { parseMemberId } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedLifecycleRunReservationInput,
  HostedLifecycleRunReservationResult,
  HostedPromotionBeginResult,
  HostedPromotionRosterBindingReadResult,
  HostedTaskAssignmentCurrentSelector,
  HostedTeamConfigurationStorageCreateResult,
  TeamDraftPublication,
} from '@features/internal-storage/contracts';
import type { InternalStorageWorkerRequest } from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close();
});

/** Every field the caller must supply fresh, captured at request time (never from a
 * frozen reservation). Individual tests mutate a copy before calling resolveCurrent. */
function fixture(options: { activate?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'hosted-task-write-currency-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'app.db');
  const productionAuthority: { current?: ReturnType<typeof createHostedPromotionCommitAuthority> } =
    {};
  const worker = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file, dbOptions) => new Database(file, dbOptions),
    promotionCommitAuthority: {
      retainForCommit: (input) =>
        productionAuthority.current?.retainForCommit(input) ?? { release() {} },
      retainForTaskWrite: (input) =>
        productionAuthority.current?.retainForTaskWrite?.(input) ?? { release() {} },
    },
  });
  dispose.push(() => worker.close());
  const userId = `usr_${'8'.repeat(32)}`;
  const sessionId = `session_${'9'.repeat(32)}`;
  const workspaceId = `workspace_${'1'.repeat(32)}`;
  const runtimeWorkspaceId = `workspace_${'2'.repeat(32)}`;
  const actorId = new NodeHostedQueryContextIdentity().projectActorId(parseUserId(userId));
  const deploymentId = `deployment_${'4'.repeat(32)}`;
  const created = worker.handle('hostedTeamConfiguration.create', {
    workspaceId,
    publicationBinding: { actorId, deploymentId, runtimeWorkspaceId, bindingGeneration: 1 },
    idempotencyKey: 'idempotency_task-write-currency-create',
    payloadHash: 'a'.repeat(64),
    metadata: { name: 'Sandbox' },
    members: [{ name: 'builder' }],
    configuration: {
      schemaVersion: 1,
      toolApprovalMode: 'auto',
      lanes: [
        {
          kind: 'opencode',
          provider: 'opencode',
          selectedModel: 'openai/gpt-6',
          members: [{ name: 'builder', prompt: 'Build.' }],
        },
      ],
    },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('fixture-create-failed');
  const teamId = created.teamId;
  const scope = { workspaceId, teamId, actorId, deploymentId };
  const publication = worker.handle(
    'draftPublication.read',
    scope as never
  ) as TeamDraftPublication;
  const promotion = worker.handle('hostedPromotion.begin', {
    ...scope,
    runtimeWorkspaceId,
    bindingGeneration: 1,
    createOperationId: publication.operationId,
    expectedRevision: created.revision,
    idempotencyKey: 'idempotency_task-write-currency-promotion',
    admittedWorkspaceRoot: '/sandbox/task-write-currency',
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedPromotionBeginResult;
  if (promotion.kind !== 'frozen') throw new Error('fixture-promotion-failed');
  const roster = worker.handle('hostedPromotion.lookupRosterBinding', {
    ...scope,
    reference: { operationId: promotion.operation.operationId },
  } as never) as HostedPromotionRosterBindingReadResult;
  if (roster?.kind !== 'found') throw new Error('fixture-roster-failed');
  const memberId = roster.binding.lanes[0]!.members[0]!.memberId;
  const db = new Database(databasePath);
  dispose.push(() => db.close());
  const pub = db
    .prepare(
      'SELECT legacy_key AS legacyKey, created_at AS createdAt FROM hosted_team_configuration_publications WHERE team_id = ?'
    )
    .get(teamId) as { legacyKey: string; createdAt: string };
  db.prepare(
    "UPDATE hosted_team_configuration_publications SET state = 'published', directory_fingerprint = ? WHERE team_id = ?"
  ).run('b'.repeat(64), teamId);
  const identities = new TeamIdentityStorageOps(() => db);
  const prepared = identities.prepareAdoption({
    teamId,
    intentId: publication.operationId,
    legacyKey: pub.legacyKey,
    directoryFingerprint: 'b'.repeat(64),
    workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
    expectedIdentityChecksum: 'c'.repeat(64),
    preparedAt: pub.createdAt,
  } as never);
  const transition = {
    teamId,
    intentId: publication.operationId,
    intentChecksum: prepared.intent.intentChecksum,
    identityChecksum: 'c'.repeat(64),
  };
  identities.recordIdentityFilePublished({
    ...transition,
    filePublishedAt: new Date(Date.parse(pub.createdAt) + 1000).toISOString(),
  } as never);
  identities.commitAdoption({
    ...transition,
    committedAt: new Date(Date.parse(pub.createdAt) + 2000).toISOString(),
  } as never);
  const input: HostedLifecycleRunReservationInput = {
    schemaVersion: 1,
    workspaceId: workspaceId as never,
    runtimeWorkspaceId: runtimeWorkspaceId as never,
    teamId,
    actorId: actorId as never,
    deploymentId: deploymentId as never,
    bootId: `boot_${'5'.repeat(32)}` as never,
    commandId: 'lifecycle-command_task-write-currency',
    idempotencyKey: 'idempotency_task-write-currency-run',
    expectedRevision: 'revision_owner-one' as never,
    expectedPlanGeneration: promotion.operation.planGeneration,
    ownerAuthority: 'owner-authority_task-write-currency',
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_task-write-currency',
    restoreGeneration: 1,
    mountGeneration: 1,
    ownerEffectFence: { grantRevision: 'd'.repeat(64), identityChecksum: 'c'.repeat(64) },
    authorityEvidence: { userId, sessionId, grantGeneration: 1 },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  };
  const reserved = worker.handle(
    'hostedLifecycleRun.reserve',
    input as never
  ) as HostedLifecycleRunReservationResult;
  if (reserved.kind !== 'reserved') throw new Error('fixture-reservation-failed');
  const runId = reserved.reservation.runId;
  db.prepare(
    'INSERT INTO users (user_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
  ).run(userId, 'Owner', 'active');
  db.prepare(
    'INSERT INTO hosted_workspaces (runtime_workspace_id, public_workspace_id, display_name, status, registered_at) VALUES (?, ?, ?, ?, 1)'
  ).run(runtimeWorkspaceId, workspaceId, 'Sandbox', 'active');
  db.prepare(
    'INSERT INTO hosted_workspace_grants (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by) VALUES (?, ?, 1, ?, 1, ?)'
  ).run(userId, runtimeWorkspaceId, 'd'.repeat(64), 'local-cli');
  db.prepare(
    'INSERT INTO hosted_auth_configuration (singleton, auth_mode, configured_at) VALUES (1, ?, 1)'
  ).run('oidc');
  db.prepare(
    `INSERT INTO operator_sessions (session_id, user_id, secret_hash, authentication_method,
    provider_id, provider_issuer, provider_subject, issued_at, last_used_at, idle_expires_at,
    absolute_expires_at, status) VALUES (?, ?, ?, 'oidc', 'provider', 'issuer', 'subject', 1, 1, 200, 200, 'active')`
  ).run(sessionId, userId, 'e'.repeat(64));
  db.prepare(
    "INSERT INTO role_snapshots (session_id, role, source, captured_at) VALUES (?, 'owner', 'oidc-claim', 1)"
  ).run(sessionId);
  const binding = {
    deploymentId,
    runtimeWorkspaceId,
    admittedWorkspaceRoot: promotion.operation.admittedWorkspaceRoot,
    restoreGeneration: 1,
  };
  productionAuthority.current = createHostedPromotionCommitAuthority(
    () => worker.databaseForPromotionCommit(),
    binding,
    () => 100
  );
  const epoch = {
    deploymentId: input.deploymentId,
    bootId: input.bootId,
    ownerAuthority: input.ownerAuthority,
    ownerGeneration: input.ownerGeneration,
    ownerSessionId: input.ownerSessionId,
    restoreGeneration: input.restoreGeneration,
    mountGeneration: input.mountGeneration,
  };
  if (options.activate !== false) {
    const currentAuthority = worker.handle('hostedLifecycleCurrent.setAuthority', {
      binding: epoch,
      expectedRevision: null,
    } as never);
    if ((currentAuthority as { kind: string }).kind !== 'applied')
      throw new Error('fixture-current-authority-failed');
    const activated = worker.handle('hostedLifecycleCurrent.activateRun', {
      binding: epoch,
      runId,
    } as never);
    if (activated !== 'activated') throw new Error('fixture-run-activation-failed');
  }
  db.pragma('busy_timeout = 0');
  const client = createHostedTaskAssignmentCurrentWorkerClient((async (
    op: InternalStorageWorkerRequest['op'],
    payload: InternalStorageWorkerRequest['payload']
  ) => worker.handle(op, payload)) as never);
  const requester = Object.freeze({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId,
    sessionId,
    grantRevision: 'd'.repeat(64),
    grantGeneration: 1,
  });
  const selector: HostedTaskAssignmentCurrentSelector = Object.freeze({
    deploymentId: epoch.deploymentId,
    teamId,
    writerEpoch: epoch,
    requester,
    identityChecksum: 'c'.repeat(64),
    target: Object.freeze({ kind: 'member', memberId: parseMemberId(memberId) }),
  }) as never;
  return {
    db,
    databasePath,
    worker,
    client,
    input,
    runId,
    teamId,
    memberId,
    epoch,
    userId,
    sessionId,
    workspaceId,
    runtimeWorkspaceId,
    selector,
  };
}

type Fixture = ReturnType<typeof fixture>;

function noneTarget(f: Fixture): HostedTaskAssignmentCurrentSelector {
  return { ...f.selector, target: { kind: 'none' } };
}

describe('hosted Product task write currency (W/T/R/M)', () => {
  it('is never classified as an internal storage mutation', () => {
    expect(isInternalStorageMutation('hostedTaskAssignment.resolveCurrent')).toBe(false);
  });

  it.each(['none', 'member'] as const)(
    'allows a %s-target write in the current epoch against an eligible run',
    async (kind) => {
      const f = fixture();
      const selector = kind === 'none' ? noneTarget(f) : f.selector;
      expect(await f.client.resolveCurrent(selector)).toEqual({ ...f.epoch, runId: f.runId });
    }
  );

  it.each(['none', 'member'] as const)(
    'allows a %s-target write with no active run at all (command stopped)',
    async (kind) => {
      const f = fixture({ activate: false });
      const selector = kind === 'none' ? noneTarget(f) : f.selector;
      const pin = await f.client.resolveCurrent(selector);
      expect(pin).toEqual({ ...f.epoch, runId: null });
    }
  );

  it('denies a member-target write while the run is cleanup_pending, but allows none-target', async () => {
    const f = fixture();
    f.worker.handle('hostedLifecycleCurrent.retireRun', {
      binding: f.epoch,
      runId: f.runId,
    } as never);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
    expect(await f.client.resolveCurrent(noneTarget(f))).toEqual({ ...f.epoch, runId: null });
  });

  it.each(['none', 'member'] as const)(
    'denies a %s-target write once a newer Owner epoch supersedes the writer',
    async (kind) => {
      const f = fixture();
      const selector = kind === 'none' ? noneTarget(f) : f.selector;
      const newer = { ...f.epoch, ownerGeneration: 2, ownerSessionId: 'owner-session_task-write-newer' };
      const applied = f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: newer,
        expectedRevision: 1,
      } as never);
      expect((applied as { kind: string }).kind).toBe('applied');
      expect(await f.client.resolveCurrent(selector)).toBeNull();
    }
  );

  it.each(['none', 'member'] as const)(
    'denies a %s-target write once the same epoch is explicitly retired',
    async (kind) => {
      const f = fixture();
      const selector = kind === 'none' ? noneTarget(f) : f.selector;
      const retired = f.worker.handle('hostedLifecycleCurrent.retireAuthority', {
        binding: f.epoch,
        expectedRevision: 1,
      } as never);
      expect((retired as { kind: string }).kind).toBe('applied');
      expect(await f.client.resolveCurrent(selector)).toBeNull();
    }
  );

  it('allows the writer before any authority row has ever been published for this deployment', async () => {
    const f = fixture({ activate: false });
    expect(await f.client.resolveCurrent(noneTarget(f))).toEqual({ ...f.epoch, runId: null });
  });

  it('rejects a revoked or role-downgraded live session even with a valid frozen reservation', async () => {
    const f = fixture();
    f.db.prepare("UPDATE operator_sessions SET status = 'revoked' WHERE session_id = ?").run(f.sessionId);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
    f.db.prepare("UPDATE operator_sessions SET status = 'active' WHERE session_id = ?").run(f.sessionId);
    f.db.prepare("UPDATE role_snapshots SET role = 'viewer' WHERE session_id = ?").run(f.sessionId);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
  });

  it('fixes session rotation: a freshly issued session is honored and the revoked predecessor is not', async () => {
    const f = fixture();
    const rotatedSessionId = `session_${'7'.repeat(32)}`;
    f.db.prepare(
      `INSERT INTO operator_sessions (session_id, user_id, secret_hash, authentication_method,
      provider_id, provider_issuer, provider_subject, issued_at, last_used_at, idle_expires_at,
      absolute_expires_at, status) VALUES (?, ?, ?, 'oidc', 'provider', 'issuer', 'subject', 1, 1, 200, 200, 'active')`
    ).run(rotatedSessionId, f.userId, 'f'.repeat(64));
    f.db.prepare("INSERT INTO role_snapshots (session_id, role, source, captured_at) VALUES (?, 'owner', 'oidc-claim', 1)").run(rotatedSessionId);
    f.db.prepare("UPDATE operator_sessions SET status = 'revoked' WHERE session_id = ?").run(f.sessionId);
    // The reservation was captured under the now-revoked session; a stale implementation that
    // re-validated the reservation's own frozen evidence would incorrectly fail here forever.
    const withRotatedSession = {
      ...f.selector,
      requester: { ...f.selector.requester, sessionId: rotatedSessionId },
    };
    expect(await f.client.resolveCurrent(withRotatedSession)).toEqual({ ...f.epoch, runId: f.runId });
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
  });

  it('rejects an actor derivation that does not match the authenticated user id', async () => {
    const f = fixture();
    const wrongActor = {
      ...noneTarget(f),
      requester: { ...f.selector.requester, actorId: `actor_${'f'.repeat(64)}` },
    } as never;
    expect(await f.client.resolveCurrent(wrongActor)).toBeNull();
  });

  it('denies a requester whose captured grantGeneration is stale against the current restoreGeneration', async () => {
    const f = fixture();
    const staleGeneration = {
      ...noneTarget(f),
      requester: { ...f.selector.requester, grantGeneration: 999 },
    } as never;
    expect(await f.client.resolveCurrent(staleGeneration)).toBeNull();
  });

  it('denies a live grant revoked (revision changed) since it was captured', async () => {
    const f = fixture();
    f.db.prepare('UPDATE hosted_workspace_grants SET grant_revision = ? WHERE user_id = ?').run('f'.repeat(64), f.userId);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
  });

  it('denies a team publication with no matching row for the requester workspace/actor scope', async () => {
    const f = fixture();
    const wrongTeam = { ...noneTarget(f), teamId: `team_${'9'.repeat(32)}` } as never;
    expect(await f.client.resolveCurrent(wrongTeam)).toBeNull();
  });

  it('rejects a selector whose top-level deploymentId disagrees with its own writer epoch', async () => {
    const f = fixture();
    const mismatched = {
      ...noneTarget(f),
      writerEpoch: { ...f.epoch, deploymentId: `deployment_${'9'.repeat(32)}` },
    } as never;
    await expect(f.client.resolveCurrent(mismatched)).rejects.toThrow(
      'hosted-task-assignment-selector-invalid'
    );
  });

  it('denies a changed identity checksum and a tombstoned identity record', async () => {
    const f = fixture();
    expect(await f.client.resolveCurrent({ ...f.selector, identityChecksum: 'f'.repeat(64) })).toBeNull();
    f.db.exec('DROP TRIGGER trg_team_identity_transition');
    f.db
      .prepare("UPDATE team_identity_records SET state = 'tombstoned', tombstoned_at = ? WHERE team_id = ?")
      .run('1970-01-01T00:00:01.000Z', f.teamId);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
  });

  it('denies a requester whose workspace does not match the published runtime workspace', async () => {
    const f = fixture();
    const wrongWorkspace = {
      ...noneTarget(f),
      requester: { ...f.selector.requester, workspaceId: `workspace_${'9'.repeat(32)}` },
    } as never;
    expect(await f.client.resolveCurrent(wrongWorkspace)).toBeNull();
  });

  it('denies a member no longer in the frozen roster and one explicitly retired', async () => {
    const f = fixture();
    const unknownMember = {
      ...f.selector,
      target: { kind: 'member', memberId: `member_${'0'.repeat(32)}` },
    } as never;
    expect(await f.client.resolveCurrent(unknownMember)).toBeNull();
    f.worker.handle('hostedLifecycleCurrent.retireMember', {
      binding: f.epoch,
      runId: f.runId,
      memberId: f.memberId,
    } as never);
    expect(await f.client.resolveCurrent(f.selector)).toBeNull();
  });

  it('serializes W/T/R/M resolution against a revoker on another SQLite connection', () => {
    const f = fixture();
    const other = new Database(f.databasePath);
    dispose.push(() => other.close());
    other.pragma('busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    try {
      expect(() => f.worker.handle('hostedTaskAssignment.resolveCurrent', f.selector as never)).toThrow('locked');
      other.prepare('DELETE FROM hosted_workspace_grants WHERE user_id = ?').run(f.userId);
      other.exec('COMMIT');
    } catch (error) {
      if (other.inTransaction) other.exec('ROLLBACK');
      throw error;
    }
    expect(f.worker.handle('hostedTaskAssignment.resolveCurrent', f.selector as never)).toBeNull();
  });

  it('keeps a busy invalidator serialized while the authority lock is held mid-decision', () => {
    const f = fixture();
    const other = new Database(f.databasePath);
    dispose.push(() => other.close());
    other.pragma('busy_timeout = 0');
    const db = f.worker.databaseForPromotionCommit();
    db.exec('BEGIN IMMEDIATE');
    try {
      expect(() =>
        other
          .prepare(
            "UPDATE hosted_lifecycle_deployment_authorities SET state = 'retired' WHERE deployment_id = ?"
          )
          .run(f.epoch.deploymentId)
      ).toThrow('locked');
    } finally {
      db.exec('ROLLBACK');
    }
  });
});
