import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseUserId } from '@features/hosted-access/contracts';
import { NodeHostedQueryContextIdentity } from '@features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { HostedCurrentMemberAdmissionOps } from '@features/internal-storage/main/infrastructure/worker/hostedCurrentMemberAdmissionOps';
import { createHostedPromotionCommitAuthority } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionCommitAuthority';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
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

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-current-member-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'app.db');
  const worker = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file, options) => new Database(file, options),
    promotionCommitAuthority: { retainForCommit: () => ({ release() {} }) },
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
      lanes: [{ kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-6',
        members: [{ name: 'builder', prompt: 'Build.' }] }],
    },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as never) as HostedTeamConfigurationStorageCreateResult;
  if (created.kind !== 'created') throw new Error('fixture-create-failed');
  const teamId = created.teamId;
  const scope = { workspaceId, teamId, actorId, deploymentId };
  const publication = worker.handle('draftPublication.read', scope as never) as TeamDraftPublication;
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
    ...scope, reference: { operationId: promotion.operation.operationId },
  } as never) as HostedPromotionRosterBindingReadResult;
  if (roster?.kind !== 'found') throw new Error('fixture-roster-failed');
  const memberId = roster.binding.lanes[0]!.members[0]!.memberId;
  const db = new Database(databasePath);
  dispose.push(() => db.close());
  const pub = db.prepare('SELECT legacy_key AS legacyKey, created_at AS createdAt FROM hosted_team_configuration_publications WHERE team_id = ?')
    .get(teamId) as { legacyKey: string; createdAt: string };
  db.prepare("UPDATE hosted_team_configuration_publications SET state = 'published', directory_fingerprint = ? WHERE team_id = ?")
    .run('b'.repeat(64), teamId);
  const identities = new TeamIdentityStorageOps(() => db);
  const prepared = identities.prepareAdoption({
    teamId, intentId: publication.operationId, legacyKey: pub.legacyKey,
    directoryFingerprint: 'b'.repeat(64),
    workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
    expectedIdentityChecksum: 'c'.repeat(64), preparedAt: pub.createdAt,
  } as never);
  const transition = { teamId, intentId: publication.operationId,
    intentChecksum: prepared.intent.intentChecksum, identityChecksum: 'c'.repeat(64) };
  identities.recordIdentityFilePublished({ ...transition,
    filePublishedAt: new Date(Date.parse(pub.createdAt) + 1000).toISOString() } as never);
  identities.commitAdoption({ ...transition,
    committedAt: new Date(Date.parse(pub.createdAt) + 2000).toISOString() } as never);
  const input: HostedLifecycleRunReservationInput = {
    schemaVersion: 1, workspaceId: workspaceId as never,
    runtimeWorkspaceId: runtimeWorkspaceId as never, teamId,
    actorId: actorId as never, deploymentId: deploymentId as never,
    bootId: `boot_${'5'.repeat(32)}` as never,
    commandId: 'lifecycle-command_member-admission',
    idempotencyKey: 'idempotency_member-admission-run',
    expectedRevision: 'revision_owner-one' as never,
    expectedPlanGeneration: promotion.operation.planGeneration,
    ownerAuthority: 'owner-authority_member-admission', ownerGeneration: 1,
    ownerSessionId: 'owner-session_member-admission', restoreGeneration: 1,
    mountGeneration: 1,
    ownerEffectFence: { grantRevision: 'd'.repeat(64), identityChecksum: 'c'.repeat(64) },
    authorityEvidence: { userId, sessionId, grantGeneration: 1 },
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  };
  const reserved = worker.handle('hostedLifecycleRun.reserve', input as never) as HostedLifecycleRunReservationResult;
  if (reserved.kind !== 'reserved') throw new Error('fixture-reservation-failed');
  const runId = reserved.reservation.runId;
  db.prepare('INSERT INTO users (user_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(userId, 'Owner', 'active');
  db.prepare('INSERT INTO hosted_workspaces (runtime_workspace_id, public_workspace_id, display_name, status, registered_at) VALUES (?, ?, ?, ?, 1)')
    .run(runtimeWorkspaceId, workspaceId, 'Sandbox', 'active');
  db.prepare('INSERT INTO hosted_workspace_grants (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by) VALUES (?, ?, 1, ?, 1, ?)')
    .run(userId, runtimeWorkspaceId, 'd'.repeat(64), 'local-cli');
  db.prepare('INSERT INTO hosted_auth_configuration (singleton, auth_mode, configured_at) VALUES (1, ?, 1)').run('oidc');
  db.prepare(`INSERT INTO operator_sessions (session_id, user_id, secret_hash, authentication_method,
    provider_id, provider_issuer, provider_subject, issued_at, last_used_at, idle_expires_at,
    absolute_expires_at, status) VALUES (?, ?, ?, 'oidc', 'provider', 'issuer', 'subject', 1, 1, 200, 200, 'active')`)
    .run(sessionId, userId, 'e'.repeat(64));
  db.prepare("INSERT INTO role_snapshots (session_id, role, source, captured_at) VALUES (?, 'owner', 'oidc-claim', 1)")
    .run(sessionId);
  const binding = { deploymentId, runtimeWorkspaceId,
    admittedWorkspaceRoot: promotion.operation.admittedWorkspaceRoot, restoreGeneration: 1 };
  const authority = createHostedPromotionCommitAuthority(() => db, binding, () => 100);
  const current = new HostedCurrentMemberAdmissionOps(() => db, () => 100, () => authority);
  db.pragma('busy_timeout = 0');
  return { db, databasePath, runId, memberId, current, userId, sessionId,
    runtimeWorkspaceId, roster };
}

describe('current hosted member admission', () => {
  it('resolves only a frozen member with current publication, identity and Product auth', () => {
    const f = fixture();
    expect(f.current.resolve(f.runId, f.memberId)).toMatchObject({
      kind: 'admitted', runId: f.runId, memberId: f.memberId,
      grantRevision: 'd'.repeat(64), grantGeneration: 1,
    });
    expect(f.current.resolve(f.runId, `member_${'0'.repeat(32)}`)).toBeNull();
    expect(f.current.resolve(`run_${'0'.repeat(32)}`, f.memberId)).toBeNull();
  });

  it('fails closed after revocation, regrant with same generation, and session expiry', () => {
    const f = fixture();
    f.db.prepare('DELETE FROM hosted_workspace_grants WHERE user_id = ?').run(f.userId);
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db.prepare('INSERT INTO hosted_workspace_grants (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by) VALUES (?, ?, 1, ?, 2, ?)')
      .run(f.userId, f.runtimeWorkspaceId, 'f'.repeat(64), 'local-cli');
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db.prepare('UPDATE hosted_workspace_grants SET grant_revision = ?').run('d'.repeat(64));
    f.db.prepare('UPDATE operator_sessions SET idle_expires_at = 100 WHERE session_id = ?').run(f.sessionId);
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
  });

  it('rejects changed active identity and roster bytes', () => {
    const f = fixture();
    f.db.exec('DROP TRIGGER trg_team_identity_transition');
    f.db.exec("UPDATE team_identity_records SET identity_checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'");
    expect(f.current.resolve(f.runId, f.memberId)).toBeNull();
    f.db.exec("UPDATE team_identity_records SET identity_checksum = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'");
    f.db.exec('DROP TRIGGER hosted_roster_bindings_no_update');
    const binding = structuredClone(f.roster.binding);
    (binding.lanes[0]!.members[0] as { name: string }).name = 'intruder';
    f.db.prepare('UPDATE hosted_promotion_roster_bindings SET binding_json = ?').run(JSON.stringify(binding));
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
