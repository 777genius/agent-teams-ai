import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseUserId } from '@features/hosted-access/contracts';
import { NodeHostedQueryContextIdentity } from '@features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { createHostedCurrentMemberAdmissionWorkerClient } from '@features/internal-storage/main/infrastructure/HostedCurrentMemberAdmissionWorkerClient';
import { createHostedLifecycleCurrentAuthorityWorkerClient } from '@features/internal-storage/main/infrastructure/HostedLifecycleCurrentAuthorityWorkerClient';
import { createHostedLifecycleRunReservationWorkerClient } from '@features/internal-storage/main/infrastructure/HostedLifecycleRunReservationWorkerClient';
import { HostedCurrentMemberAdmissionOps } from '@features/internal-storage/main/infrastructure/worker/hostedCurrentMemberAdmissionOps';
import { createHostedPromotionCommitAuthority } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionCommitAuthority';
import { isInternalStorageMutation } from '@features/internal-storage/main/infrastructure/worker/internalStorageMutationClassification';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import { reserveHostedLifecycleLaunchRun } from '@features/team-lifecycle/main/adapters/output/orchestrator/reserveHostedLifecycleLaunchRun';
import { TeamLifecycleCurrentRunRetirement } from '@main/composition/hosted/teamLifecycleCurrentRunRetirement';
import {
  ensureProductTaskWriteLockDirectory,
  withProductTaskWriteAuthorityLockSync,
} from '@main/utils/productTaskWriteAuthorityLock';
import { createQueryContext, parseAuthorizedScope } from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedLifecycleRunReservationInput,
  HostedLifecycleRunReservationResult,
  HostedPromotionBeginResult,
  HostedPromotionRosterBindingReadResult,
  HostedTeamConfigurationStorageCreateResult,
  TeamDraftPublication,
} from '@features/internal-storage/contracts';
import type { InternalStorageWorkerRequest } from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close();
});

function fixture(options: { activate?: boolean; productAuthorityLock?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'hosted-current-member-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'app.db');
  const lockDirectory = options.productAuthorityLock
    ? ensureProductTaskWriteLockDirectory(root)
    : null;
  const productionAuthority: { current?: ReturnType<typeof createHostedPromotionCommitAuthority> } =
    {};
  const worker = new InternalStorageWorkerCore({
    databasePath,
    ...(lockDirectory === null
      ? {}
      : {
          productAuthorityLockSync: <T>(work: () => T): T =>
            withProductTaskWriteAuthorityLockSync(lockDirectory, work),
        }),
    createDatabase: (file, options) => new Database(file, options),
    promotionCommitAuthority: {
      retainForCommit: (input) =>
        productionAuthority.current?.retainForCommit(input) ?? { release() {} },
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
    idempotencyKey: 'idempotency_member-admission-create',
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
    idempotencyKey: 'idempotency_member-admission-promotion',
    admittedWorkspaceRoot: '/sandbox/member-admission',
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
    commandId: 'lifecycle-command_member-admission',
    idempotencyKey: 'idempotency_member-admission-run',
    expectedRevision: 'revision_owner-one' as never,
    expectedPlanGeneration: promotion.operation.planGeneration,
    ownerAuthority: 'owner-authority_member-admission',
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_member-admission',
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
  const authority = createHostedPromotionCommitAuthority(
    () => db,
    binding,
    () => 100
  );
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
  const current = new HostedCurrentMemberAdmissionOps(
    () => db,
    () => 100,
    () => authority
  );
  db.pragma('busy_timeout = 0');
  return {
    db,
    databasePath,
    lockDirectory,
    input,
    runId,
    teamId,
    memberId,
    current,
    worker,
    epoch,
    userId,
    sessionId,
    runtimeWorkspaceId,
    roster,
  };
}

describe('current hosted member admission', () => {
  it('refuses retirement and other-team invalidation while the deployment lock is held', () => {
    const f = fixture({ productAuthorityLock: true });
    if (f.lockDirectory === null) throw new Error('fixture-lock-missing');
    withProductTaskWriteAuthorityLockSync(f.lockDirectory, () => {
      expect(() =>
        f.worker.handle('hostedLifecycleCurrent.retireRun', {
          binding: f.epoch,
          runId: f.runId,
        } as never)
      ).toThrow('product-authority-lock-transient-busy');
      expect(f.current.resolve(f.runId, f.memberId)).toMatchObject({ kind: 'admitted' });
      expect(() =>
        f.worker.handle('teamIdentity.tombstone', {
          teamId: `team_${'a'.repeat(32)}`,
        } as never)
      ).toThrow('product-authority-lock-transient-busy');
      expect(() =>
        f.worker.handle('hostedAuth.call', {
          operation: 'workspace.grant.revoke',
          payload: { userId: f.userId, runtimeWorkspaceId: f.runtimeWorkspaceId },
        })
      ).toThrow('product-authority-lock-transient-busy');
    });
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('cleanup_pending');
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
  });

  it('denies historical reservations until the trusted epoch and run are activated', () => {
    const f = fixture({ activate: false });
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('conflict');
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: f.epoch,
        expectedRevision: null,
      } as never)
    ).toEqual({ kind: 'applied', revision: 1 });
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('activated');
    expect(f.current.resolve(f.runId, f.memberId)).toMatchObject({ kind: 'admitted' });
  });

  it('retires a member and run irreversibly, including exact activation replay', () => {
    const f = fixture();
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('already_current');
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireMember', {
        binding: f.epoch,
        runId: f.runId,
        memberId: f.memberId,
      } as never)
    ).toBe('retired');
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireMember', {
        binding: f.epoch,
        runId: f.runId,
        memberId: f.memberId,
      } as never)
    ).toBe('already_retired');
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('cleanup_pending');
    expect(
      f.worker.handle('hostedLifecycleCurrent.lookupTeamRun', {
        deploymentId: f.epoch.deploymentId,
        teamId: f.teamId,
      } as never)
    ).toMatchObject({ runId: f.runId, state: 'cleanup_pending' });
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('conflict');
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('already_pending');
    expect(
      f.worker.handle('hostedLifecycleCurrent.confirmRunRetired', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('retired');
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('already_retired');
    expect(() =>
      f.db
        .prepare(
          `INSERT OR REPLACE INTO hosted_lifecycle_current_runs
      SELECT * FROM hosted_lifecycle_current_runs WHERE run_id = ?`
        )
        .run(f.runId)
    ).toThrow('binding invalid');
    expect(() =>
      f.db
        .prepare(
          `UPDATE hosted_lifecycle_current_runs SET state = 'eligible'
      WHERE run_id = ?`
        )
        .run(f.runId)
    ).toThrow('transition invalid');
  });

  it('blocks the next run while cleanup is pending and admits it only after terminal confirmation', () => {
    const f = fixture();
    const secondInput = {
      ...f.input,
      commandId: 'lifecycle-command_member-admission-second',
      idempotencyKey: 'idempotency_member-admission-second',
      expectedRevision: 'revision_owner-two' as never,
    };
    const reserved = f.worker.handle(
      'hostedLifecycleRun.reserve',
      secondInput as never
    ) as HostedLifecycleRunReservationResult;
    expect(reserved.kind).toBe('reserved');
    if (reserved.kind !== 'reserved') return;
    const secondRunId = reserved.reservation.runId;
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('cleanup_pending');
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: secondRunId,
      } as never)
    ).toBe('conflict');
    expect(
      f.worker.handle('hostedLifecycleCurrent.confirmRunRetired', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('retired');
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: secondRunId,
      } as never)
    ).toBe('activated');
    expect(f.current.resolve(secondRunId, f.memberId)).toMatchObject({ kind: 'admitted' });
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireAuthority', {
        binding: f.epoch,
        expectedRevision: 1,
      } as never)
    ).toEqual({ kind: 'applied', revision: 2 });
    expect(f.current.resolve(secondRunId, f.memberId)).toBeNull();
  });

  it('runs the Product composition stop and next-launch gate against real SQLite', async () => {
    const f = fixture();
    const call = (async (
      op: InternalStorageWorkerRequest['op'],
      payload: InternalStorageWorkerRequest['payload']
    ) => f.worker.handle(op, payload)) as never;
    const currentGateway = createHostedLifecycleCurrentAuthorityWorkerClient(call);
    const reservations = createHostedLifecycleRunReservationWorkerClient(call);
    const owner = {
      ownerAuthority: f.epoch.ownerAuthority,
      ownerGeneration: f.epoch.ownerGeneration,
      ownerSessionId: f.epoch.ownerSessionId,
      socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 },
    };
    const context = createQueryContext({
      actorId: f.input.actorId,
      sessionId: f.sessionId as never,
      deploymentId: f.epoch.deploymentId,
      bootId: f.epoch.bootId,
      requestId: 'request_current-run-retirement' as never,
      authorizedScope: parseAuthorizedScope('scope_hosted-lifecycle-command'),
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    });
    const terminal = new TeamLifecycleCurrentRunRetirement({
      current: () => currentGateway,
      reservations: () => reservations,
      currentOwner: () => owner,
      expectedOwner: owner,
      restoreGeneration: f.epoch.restoreGeneration,
      mountGeneration: f.epoch.mountGeneration,
      fenceForContext: () => ({
        publicWorkspaceId: f.input.workspaceId,
        runtimeWorkspaceId: f.input.runtimeWorkspaceId,
        revalidate: async () => true,
      }),
      controlState: async () => ({
        schemaVersion: 1,
        kind: 'control_state',
        workspaceId: f.input.runtimeWorkspaceId,
        teamId: f.teamId,
        deploymentId: f.epoch.deploymentId,
        bootId: f.epoch.bootId,
        runId: null,
        resourceRevision: 'revision_owner-two' as never,
        availableActions: ['launch'],
      }),
    });
    const stop = {
      schemaVersion: 1,
      action: 'stop',
      commandId: 'lifecycle-command_member-admission-stop',
      idempotencyKey: 'idempotency_member-admission-stop',
      workspaceId: f.input.runtimeWorkspaceId,
      teamId: f.teamId,
      expectedRevision: f.input.expectedRevision,
      runId: f.runId,
    } as never;
    expect(await terminal.beforeNonLaunchExecute(stop, context)).toBe(true);
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(await terminal.afterTerminalReceipt(stop, context)).toBe(true);
    const next = await reservations.reserve(
      {
        ...f.input,
        commandId: 'lifecycle-command_member-admission-after-stop' as never,
        idempotencyKey: 'idempotency_member-admission-after-stop' as never,
        expectedRevision: 'revision_owner-two' as never,
      },
      { signal: context.signal }
    );
    expect(next.kind).toBe('reserved');
    if (next.kind !== 'reserved') return;
    expect(
      await currentGateway.activateReservedRun({ binding: f.epoch, runId: next.reservation.runId })
    ).toBe('activated');
    expect(f.current.resolve(next.reservation.runId, f.memberId)).toMatchObject({
      kind: 'admitted',
    });
  });

  it('rotates a newer Owner boot/session and cannot reauthorize the prior run', () => {
    const f = fixture();
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: { ...f.epoch, bootId: `boot_${'6'.repeat(32)}` },
        expectedRevision: 1,
      } as never)
    ).toEqual({ kind: 'conflict' });
    const next = {
      ...f.epoch,
      bootId: `boot_${'6'.repeat(32)}`,
      ownerGeneration: f.epoch.ownerGeneration + 1,
      ownerSessionId: 'owner-session_member-admission-next',
    };
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: next,
        expectedRevision: 1,
      } as never)
    ).toEqual({ kind: 'applied', revision: 2 });
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('conflict');
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: f.epoch,
        expectedRevision: 2,
      } as never)
    ).toEqual({ kind: 'conflict' });
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: { ...next, ownerGeneration: next.ownerGeneration + 1 },
        expectedRevision: 1,
      } as never)
    ).toEqual({ kind: 'conflict' });
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireAuthority', {
        binding: f.epoch,
        expectedRevision: 2,
      } as never)
    ).toEqual({ kind: 'conflict' });
    expect(
      f.worker.handle('hostedLifecycleCurrent.lookupAuthority', f.epoch.deploymentId as never)
    ).toMatchObject({ bootId: next.bootId, ownerSessionId: next.ownerSessionId, revision: 2 });
  });

  it('retires the Owner epoch on loss and refuses same-session resurrection', () => {
    const f = fixture();
    expect(
      f.worker.handle('hostedLifecycleCurrent.retireAuthority', {
        binding: f.epoch,
        expectedRevision: 1,
      } as never)
    ).toEqual({ kind: 'applied', revision: 2 });
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(f.worker.handle('hostedLifecycleCurrent.lookupRun', f.runId as never)).toMatchObject({
      state: 'cleanup_pending',
    });
    expect(
      f.worker.handle('hostedLifecycleCurrent.setAuthority', {
        binding: f.epoch,
        expectedRevision: 2,
      } as never)
    ).toEqual({ kind: 'conflict' });
    expect(
      f.worker.handle('hostedLifecycleCurrent.activateRun', {
        binding: f.epoch,
        runId: f.runId,
      } as never)
    ).toBe('conflict');
    expect(() =>
      f.db
        .prepare(
          `INSERT OR REPLACE INTO hosted_lifecycle_deployment_authorities
      SELECT * FROM hosted_lifecycle_deployment_authorities WHERE deployment_id = ?`
        )
        .run(f.epoch.deploymentId)
    ).toThrow('retained');
  });

  it('tombstones an absent Owner epoch before an in-flight launch can publish it', async () => {
    const f = fixture({ activate: false });
    const call = (async (
      op: InternalStorageWorkerRequest['op'],
      payload: InternalStorageWorkerRequest['payload']
    ) => f.worker.handle(op, payload)) as never;
    const current = createHostedLifecycleCurrentAuthorityWorkerClient(call);
    const reservations = createHostedLifecycleRunReservationWorkerClient(call);
    const owner = {
      ownerAuthority: f.epoch.ownerAuthority,
      ownerGeneration: f.epoch.ownerGeneration,
      ownerSessionId: f.epoch.ownerSessionId,
      socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 },
    };
    const retirement = new TeamLifecycleCurrentRunRetirement({
      current: () => current,
      reservations: () => reservations,
      currentOwner: () => owner,
      expectedOwner: owner,
      restoreGeneration: f.epoch.restoreGeneration,
      mountGeneration: f.epoch.mountGeneration,
      fenceForContext: () => null,
      controlState: async () => ({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }),
    });
    const context = createQueryContext({
      actorId: f.input.actorId,
      sessionId: f.sessionId as never,
      deploymentId: f.epoch.deploymentId,
      bootId: f.epoch.bootId,
      requestId: 'request_current-run-owner-loss' as never,
      authorizedScope: parseAuthorizedScope('scope_hosted-lifecycle-command'),
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    });
    let releaseGrantCheck: (() => void) | undefined;
    let grantCheckEntered: (() => void) | undefined;
    const grantCheck = new Promise<void>((resolve) => {
      releaseGrantCheck = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      grantCheckEntered = resolve;
    });
    let revalidations = 0;
    let authorizationCurrent = true;
    const launch = reserveHostedLifecycleLaunchRun({
      command: {
        schemaVersion: 1,
        action: 'launch',
        commandId: f.input.commandId,
        idempotencyKey: f.input.idempotencyKey,
        workspaceId: f.input.runtimeWorkspaceId,
        teamId: f.teamId,
        expectedRevision: f.input.expectedRevision,
      } as never,
      context,
      grantFence: {
        publicWorkspaceId: f.input.workspaceId,
        runtimeWorkspaceId: f.input.runtimeWorkspaceId,
        authorityEvidence: f.input.authorityEvidence,
        ownerEffectFence: f.input.ownerEffectFence,
        revalidate: async () => {
          if (++revalidations === 2) {
            grantCheckEntered?.();
            await grantCheck;
          }
          return true;
        },
      },
      ownerEffectFence: f.input.ownerEffectFence,
      ownerBinding: owner,
      restoreGeneration: f.epoch.restoreGeneration,
      mountGeneration: f.epoch.mountGeneration,
      reservations,
      authorizationIsCurrent: () => authorizationCurrent,
    });
    await entered;
    authorizationCurrent = false;
    await retirement.retireLostOwner(f.epoch);
    expect(await current.lookupAuthority(f.epoch.deploymentId)).toMatchObject({
      state: 'retired',
      revision: 1,
    });
    releaseGrantCheck?.();
    expect(await launch).toBeNull();
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(await current.setCurrentAuthority({ binding: f.epoch, expectedRevision: 1 })).toEqual({
      kind: 'conflict',
    });
    const successor = {
      ...f.epoch,
      ownerGeneration: f.epoch.ownerGeneration + 1,
      ownerSessionId: 'owner-session_member-admission-successor',
    };
    expect(await current.setCurrentAuthority({ binding: successor, expectedRevision: 1 })).toEqual({
      kind: 'applied',
      revision: 2,
    });
    await retirement.retireLostOwner(f.epoch);
    expect(await current.lookupAuthority(f.epoch.deploymentId)).toMatchObject({
      ownerSessionId: successor.ownerSessionId,
      state: 'active',
      revision: 2,
    });
  });

  it('advances a retired predecessor tombstone across a newer Owner loss during grant revalidation', async () => {
    const f = fixture({ activate: false });
    const call = (async (
      op: InternalStorageWorkerRequest['op'],
      payload: InternalStorageWorkerRequest['payload']
    ) => f.worker.handle(op, payload)) as never;
    const current = createHostedLifecycleCurrentAuthorityWorkerClient(call);
    const reservations = createHostedLifecycleRunReservationWorkerClient(call);
    expect(await current.setCurrentAuthority({ binding: f.epoch, expectedRevision: null })).toEqual(
      { kind: 'applied', revision: 1 }
    );
    expect(await current.retireAuthority({ binding: f.epoch, expectedRevision: null })).toEqual({
      kind: 'applied',
      revision: 2,
    });
    const newer = {
      ...f.epoch,
      ownerGeneration: f.epoch.ownerGeneration + 1,
      ownerSessionId: 'owner-session_member-admission-newer',
    };
    const input = {
      ...f.input,
      ownerGeneration: newer.ownerGeneration,
      ownerSessionId: newer.ownerSessionId,
      commandId: 'lifecycle-command_member-admission-newer' as never,
      idempotencyKey: 'idempotency_member-admission-newer' as never,
      expectedRevision: 'revision_owner-newer' as never,
    };
    expect((await reservations.reserve(input, { signal: new AbortController().signal })).kind).toBe(
      'reserved'
    );
    const context = createQueryContext({
      actorId: f.input.actorId,
      sessionId: f.sessionId as never,
      deploymentId: f.epoch.deploymentId,
      bootId: f.epoch.bootId,
      requestId: 'request_current-run-newer-loss' as never,
      authorizedScope: parseAuthorizedScope('scope_hosted-lifecycle-command'),
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    });
    let releaseCheck: (() => void) | undefined;
    let checkEntered: (() => void) | undefined;
    const heldCheck = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      checkEntered = resolve;
    });
    let checks = 0;
    let authorizationCurrent = true;
    const launch = reserveHostedLifecycleLaunchRun({
      command: {
        schemaVersion: 1,
        action: 'launch',
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.runtimeWorkspaceId,
        teamId: f.teamId,
        expectedRevision: input.expectedRevision,
      } as never,
      context,
      grantFence: {
        publicWorkspaceId: input.workspaceId,
        runtimeWorkspaceId: input.runtimeWorkspaceId,
        authorityEvidence: input.authorityEvidence,
        ownerEffectFence: input.ownerEffectFence,
        revalidate: async () => {
          if (++checks === 2) {
            checkEntered?.();
            await heldCheck;
          }
          return true;
        },
      },
      ownerEffectFence: input.ownerEffectFence,
      ownerBinding: {
        ownerAuthority: newer.ownerAuthority,
        ownerGeneration: newer.ownerGeneration,
        ownerSessionId: newer.ownerSessionId,
        socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 },
      },
      restoreGeneration: newer.restoreGeneration,
      mountGeneration: newer.mountGeneration,
      reservations,
      authorizationIsCurrent: () => authorizationCurrent,
    });
    await entered;
    authorizationCurrent = false;
    const retirement = new TeamLifecycleCurrentRunRetirement({
      current: () => current,
      reservations: () => reservations,
      currentOwner: () => null,
      expectedOwner: {
        ownerAuthority: newer.ownerAuthority,
        ownerGeneration: newer.ownerGeneration,
        ownerSessionId: newer.ownerSessionId,
        socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 },
      },
      restoreGeneration: newer.restoreGeneration,
      mountGeneration: newer.mountGeneration,
      fenceForContext: () => null,
      controlState: async () => ({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }),
    });
    await retirement.retireLostOwner(newer);
    expect(await current.lookupAuthority(f.epoch.deploymentId)).toMatchObject({
      ownerGeneration: newer.ownerGeneration,
      ownerSessionId: newer.ownerSessionId,
      state: 'retired',
      revision: 3,
    });
    releaseCheck?.();
    expect(await launch).toBeNull();
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    expect(await current.setCurrentAuthority({ binding: newer, expectedRevision: 3 })).toEqual({
      kind: 'conflict',
    });
    const successor = {
      ...newer,
      ownerGeneration: newer.ownerGeneration + 1,
      ownerSessionId: 'owner-session_member-admission-successor-2',
    };
    expect(await current.setCurrentAuthority({ binding: successor, expectedRevision: 3 })).toEqual({
      kind: 'applied',
      revision: 4,
    });
    await retirement.retireLostOwner(newer);
    expect(await current.lookupAuthority(f.epoch.deploymentId)).toMatchObject({
      ownerSessionId: successor.ownerSessionId,
      state: 'active',
      revision: 4,
    });
  });

  it('serializes a committed run retirement before any later member decision', () => {
    const f = fixture();
    const other = new Database(f.databasePath);
    dispose.push(() => other.close());
    other.pragma('busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    try {
      expect(() => f.current.resolve(f.runId, f.memberId)).toThrow('locked');
      other
        .prepare(
          "UPDATE hosted_lifecycle_current_runs SET state = 'cleanup_pending' WHERE run_id = ?"
        )
        .run(f.runId);
      other.exec('COMMIT');
    } catch (error) {
      if (other.inTransaction) other.exec('ROLLBACK');
      throw error;
    }
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
  });

  it('rejects a restored v35 marker with a missing current-run guard', () => {
    const f = fixture();
    f.db.exec('DROP TRIGGER hosted_lifecycle_current_runs_no_delete');
    const restarted = new InternalStorageWorkerCore({
      databasePath: f.databasePath,
      createDatabase: (file, options) => new Database(file, options),
    });
    dispose.push(() => restarted.close());
    expect(() => restarted.handle('ping', {})).toThrow(
      'internal-storage-v35-current-lifecycle-schema-incompatible'
    );
  });

  it('exposes only the private read operation through worker dispatch and client', async () => {
    const f = fixture();
    expect(isInternalStorageMutation('hostedLifecycleRun.resolveMember')).toBe(false);
    const client = createHostedCurrentMemberAdmissionWorkerClient((async (
      op: InternalStorageWorkerRequest['op'],
      payload: InternalStorageWorkerRequest['payload']
    ) => f.worker.handle(op, payload)) as never);
    const resolved = await client.resolve(f.runId, f.memberId);
    expect(resolved).toMatchObject({
      kind: 'admitted',
      runId: f.runId,
      memberId: f.memberId,
      grantRevision: 'd'.repeat(64),
    });
    expect(Reflect.ownKeys(resolved!)).not.toContain('authorityEvidence');
    const hostileClient = createHostedCurrentMemberAdmissionWorkerClient((async () => ({
      ...resolved,
      authorityEvidence: { sessionId: f.sessionId },
    })) as never);
    await expect(hostileClient.resolve(f.runId, f.memberId)).rejects.toThrow(
      'hosted-member-admission-result-invalid'
    );
    f.db.prepare('DELETE FROM hosted_workspace_grants WHERE user_id = ?').run(f.userId);
    expect(await client.resolve(f.runId, f.memberId)).toBeNull();
  });

  it('resolves only a frozen member with current publication, identity and Product auth', () => {
    const f = fixture();
    expect(f.current.resolve(f.runId, f.memberId)).toMatchObject({
      kind: 'admitted',
      runId: f.runId,
      memberId: f.memberId,
      grantRevision: 'd'.repeat(64),
      grantGeneration: 1,
    });
    expect(f.current.resolve(f.runId, `member_${'0'.repeat(32)}`)).toBeNull();
    expect(f.current.resolve(`run_${'0'.repeat(32)}`, f.memberId)).toBeNull();
  });

  it('fails closed after revocation, regrant with same generation, and session expiry', () => {
    const f = fixture();
    f.db.prepare('DELETE FROM hosted_workspace_grants WHERE user_id = ?').run(f.userId);
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db
      .prepare(
        'INSERT INTO hosted_workspace_grants (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by) VALUES (?, ?, 1, ?, 2, ?)'
      )
      .run(f.userId, f.runtimeWorkspaceId, 'f'.repeat(64), 'local-cli');
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db.prepare('UPDATE hosted_workspace_grants SET grant_revision = ?').run('d'.repeat(64));
    f.db
      .prepare('UPDATE operator_sessions SET idle_expires_at = 100 WHERE session_id = ?')
      .run(f.sessionId);
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
  });

  it('rejects changed active identity and roster bytes', () => {
    const f = fixture();
    f.db.exec('DROP TRIGGER trg_team_identity_transition');
    f.db.exec(
      "UPDATE team_identity_records SET identity_checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"
    );
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db.exec(
      "UPDATE team_identity_records SET identity_checksum = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'"
    );
    f.db.exec('DROP TRIGGER hosted_roster_bindings_no_update');
    const binding = structuredClone(f.roster.binding);
    (binding.lanes[0]!.members[0] as { name: string }).name = 'intruder';
    f.db
      .prepare('UPDATE hosted_promotion_roster_bindings SET binding_json = ?')
      .run(JSON.stringify(binding));
    expect(() => f.current.resolve(f.runId, f.memberId)).toThrow();
  });

  it('serializes current resolution with a revoker on another SQLite connection', () => {
    const f = fixture();
    const other = new Database(f.databasePath);
    dispose.push(() => other.close());
    other.pragma('busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    try {
      expect(() => f.current.resolve(f.runId, f.memberId)).toThrow('locked');
      other.prepare('DELETE FROM hosted_workspace_grants WHERE user_id = ?').run(f.userId);
      other.exec('COMMIT');
    } catch (error) {
      if (other.inTransaction) other.exec('ROLLBACK');
      throw error;
    }
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
  });
});
