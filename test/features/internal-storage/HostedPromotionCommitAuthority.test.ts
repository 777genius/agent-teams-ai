import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseUserId } from '@features/hosted-access/contracts';
import { NodeHostedQueryContextIdentity } from '@features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { parseHostedPromotionBegin } from '@features/internal-storage/contracts';
import { createHostedPromotionCommitAuthority } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionCommitAuthority';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const input = parseHostedPromotionBegin({
  workspaceId: `workspace_${'1'.repeat(32)}`, teamId: `team_${'2'.repeat(32)}`,
  actorId: new NodeHostedQueryContextIdentity().projectActorId(parseUserId(`usr_${'8'.repeat(32)}`)),
  deploymentId: `deployment_${'4'.repeat(32)}`,
  createOperationId: `adoption_${'5'.repeat(32)}`,
  runtimeWorkspaceId: `workspace_${'6'.repeat(32)}`, bindingGeneration: 1,
  expectedRevision: `revision_${'7'.repeat(32)}`,
  idempotencyKey: 'idempotency_promotion-commit-test',
  admittedWorkspaceRoot: '/sandbox/workspace', deadlineAtMs: Number.MAX_SAFE_INTEGER,
  authorityEvidence: { userId: `usr_${'8'.repeat(32)}`, sessionId: `session_${'9'.repeat(32)}`,
    grantRevision: 'a'.repeat(64), grantGeneration: 3 },
});
const binding = { deploymentId: input.deploymentId, runtimeWorkspaceId: input.runtimeWorkspaceId,
  admittedWorkspaceRoot: input.admittedWorkspaceRoot, restoreGeneration: 3 };

async function fixture(
  mode: 'oidc' | 'personal',
  bindingOverride: Parameters<typeof createHostedPromotionCommitAuthority>[1] = binding
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-authority-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'auth.db');
  const db = new Database(databasePath);
  const other = new Database(databasePath);
  cleanup.push(async () => { other.close(); db.close(); });
  db.exec(`CREATE TABLE hosted_workspace_grants(user_id TEXT, runtime_workspace_id TEXT,
    grant_generation INTEGER, grant_revision TEXT);
    CREATE TABLE hosted_workspaces(runtime_workspace_id TEXT, public_workspace_id TEXT, status TEXT);
    CREATE TABLE users(user_id TEXT, status TEXT);
    CREATE TABLE hosted_auth_configuration(singleton INTEGER, auth_mode TEXT);
    CREATE TABLE operator_sessions(session_id TEXT, user_id TEXT, status TEXT,
      idle_expires_at INTEGER, absolute_expires_at INTEGER);
    CREATE TABLE role_snapshots(session_id TEXT, role TEXT);
    CREATE TABLE personal_owners(singleton INTEGER, operator_id TEXT, user_id TEXT);
    CREATE TABLE hosted_access_authority(singleton INTEGER, state_json TEXT);`);
  const evidence = input.authorityEvidence!;
  db.prepare('INSERT INTO users VALUES (?, ?)').run(evidence.userId, 'active');
  db.prepare('INSERT INTO hosted_workspaces VALUES (?, ?, ?)').run(input.runtimeWorkspaceId, input.workspaceId, 'active');
  db.prepare('INSERT INTO hosted_workspace_grants VALUES (?, ?, ?, ?)').run(
    evidence.userId, input.runtimeWorkspaceId, evidence.grantGeneration, evidence.grantRevision);
  db.prepare('INSERT INTO hosted_auth_configuration VALUES (1, ?)').run(mode);
  if (mode === 'oidc') {
    db.prepare('INSERT INTO operator_sessions VALUES (?, ?, ?, ?, ?)').run(
      evidence.sessionId, evidence.userId, 'active', 1000, 1000);
    db.prepare('INSERT INTO role_snapshots VALUES (?, ?)').run(evidence.sessionId, 'owner');
  } else {
    db.prepare('INSERT INTO personal_owners VALUES (1, ?, ?)').run('operator_owner', evidence.userId);
    db.prepare('INSERT INTO hosted_access_authority VALUES (1, ?)').run(JSON.stringify({
      operatorId: 'operator_owner', binding: { deploymentId: binding.deploymentId, restoreGeneration: 3 },
      resetIntent: null,
      deviceFamilies: [{ familyId: 'family_one', operatorId: 'operator_owner', status: 'active',
        idleExpiresAt: 1000, absoluteExpiresAt: 1000 }],
      sessions: [{ sessionId: evidence.sessionId, operatorId: 'operator_owner', familyId: 'family_one', status: 'active',
        deadlines: { idleExpiresAt: 1000, absoluteExpiresAt: 1000, renewalExpiresAt: 1000 } }],
    }));
  }
  db.pragma('busy_timeout = 0');
  other.pragma('busy_timeout = 0');
  return {
    db,
    other,
    authority: createHostedPromotionCommitAuthority(() => db, bindingOverride, () => 100),
  };
}

describe('production promotion commit authority', () => {
  it('serializes a captured OIDC grant/session against revocation until IMMEDIATE commit', async () => {
    const { db, other, authority } = await fixture('oidc');
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit(input).release()).not.toThrow();
    expect(() => other.prepare('DELETE FROM hosted_workspace_grants').run()).toThrow('locked');
    db.exec('COMMIT');
    other.prepare('DELETE FROM hosted_workspace_grants').run();
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit(input)).toThrow('promotion-commit-grant-revoked');
    db.exec('ROLLBACK');
  });

  it('rejects personal session revocation observed under the same commit lock', async () => {
    const { db, other, authority } = await fixture('personal');
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit(input).release()).not.toThrow();
    db.exec('COMMIT');
    other.prepare('UPDATE hosted_access_authority SET state_json = ?').run(JSON.stringify({
      operatorId: 'operator_owner', binding: { deploymentId: binding.deploymentId, restoreGeneration: 3 },
      resetIntent: null,
      deviceFamilies: [{ familyId: 'family_one', operatorId: 'operator_owner', status: 'active',
        idleExpiresAt: 1000, absoluteExpiresAt: 1000 }],
      sessions: [{ sessionId: input.authorityEvidence!.sessionId, operatorId: 'operator_owner', familyId: 'family_one',
        status: 'revoked', deadlines: { idleExpiresAt: 1000, absoluteExpiresAt: 1000, renewalExpiresAt: 1000 } }],
    }));
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit(input)).toThrow('promotion-commit-session-revoked');
    db.exec('ROLLBACK');
  });

  it('refuses a different launcher mount even with a valid live session and grant', async () => {
    const { db, authority } = await fixture('oidc');
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit({ ...input, admittedWorkspaceRoot: '/different' }))
      .toThrow('promotion-commit-binding-invalid');
    db.exec('ROLLBACK');
  });

  it('rejects an actor disconnected from the authenticated user', async () => {
    const { db, authority } = await fixture('oidc');
    db.exec('BEGIN IMMEDIATE');
    expect(() => authority.retainForCommit({ ...input, actorId: `actor_${'f'.repeat(64)}` as typeof input.actorId }))
      .toThrow('promotion-commit-actor-mismatch');
    db.exec('ROLLBACK');
  });

  it('does not insert a freeze row when the personal session renewal deadline has passed', async () => {
    const { db, authority } = await fixture('personal');
    db.exec('CREATE TABLE hosted_team_configuration_promotions(operation_id TEXT PRIMARY KEY)');
    const row = db.prepare('SELECT state_json AS stateJson FROM hosted_access_authority').get() as { stateJson: string };
    const state = JSON.parse(row.stateJson) as { sessions: Array<{ deadlines: Record<string, number> }> };
    state.sessions[0].deadlines.renewalExpiresAt = 100;
    db.prepare('UPDATE hosted_access_authority SET state_json = ?').run(JSON.stringify(state));
    const freeze = db.transaction(() => {
      const retained = authority.retainForCommit(input);
      db.prepare('INSERT INTO hosted_team_configuration_promotions VALUES (?)').run('promotion_never');
      retained.release();
    });
    expect(() => freeze.immediate()).toThrow('promotion-commit-session-revoked');
    expect(db.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
  });

  it.each([
    ['personal', 'trusted_process', true],
    ['oidc', 'trusted_process', false],
    ['personal', undefined, false],
  ] as const)('admits native lanes only for %s mode with %s isolation', async (mode, runtimeIsolation, admitted) => {
    const { db, authority } = await fixture(mode, {
      ...binding,
      ...(runtimeIsolation ? { runtimeIsolation } : {}),
    });
    expect(() => authority.launchTopologyPolicy?.()).toThrow('promotion-commit-transaction-required');
    db.exec('BEGIN IMMEDIATE');
    expect(authority.launchTopologyPolicy?.()).toEqual({ nativeHostLocalLanes: admitted });
    db.exec('ROLLBACK');
  });
});
