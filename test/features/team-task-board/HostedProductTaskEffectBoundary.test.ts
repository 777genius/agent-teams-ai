import {
  HOSTED_PRODUCT_TASK_EFFECT_RECEIPTS_SQL,
  HostedProductTaskEffectBoundary,
  type ProductAgentAuthority,
  type ProductAgentBinding,
  type ProductEffectAuthority,
  type ProductEffectRequest,
  type ProductRecipientPin,
  type ProductTaskSnapshot,
} from '@features/team-task-board/main/infrastructure/HostedProductTaskEffectBoundary';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

const databases: Array<{ close(): void }> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const binding: ProductAgentBinding = {
  workspaceId: 'workspace_test', teamId: 'team_test', workspaceRoot: '/sandbox/product-effects',
  planGeneration: 'generation_plan-test', runId: 'run_test',
  laneId: 'lane_test', memberId: 'member_sender', memberName: 'sender', sessionID: 'session_test',
};
const authority: ProductAgentAuthority = {
  actorId: binding.memberId, deploymentId: 'deployment_test', bootId: 'boot_test',
  restoreGeneration: 1, workspaceId: binding.workspaceId, mountGeneration: 1,
  declaredRootHash: 'a'.repeat(64),
  teamId: binding.teamId, ownerAuthority: 'owner_test', ownerGeneration: 1,
  ownerSessionId: 'owner_session_test',
};
const task: ProductTaskSnapshot = {
  teamId: binding.teamId, taskId: 'task_test', sourceGeneration: 'generation_test',
  revision: 'revision_test', ownerId: binding.memberId, status: 'pending',
};
const recipient: ProductRecipientPin = {
  teamId: binding.teamId, runId: binding.runId, laneId: 'lane_peer',
  memberId: 'member_peer', memberName: 'peer',
};

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(HOSTED_PRODUCT_TASK_EFFECT_RECEIPTS_SQL);
  let current = { ...binding, ...authority };
  let currentTask = { ...task };
  let currentRecipient = { ...recipient };
  const canonical = new Map<string, { fingerprint: string; receipt: string }>();
  let writes = 0;
  let wakes = 0;
  let throwAfterFileWrite = false;
  let attested = true;
  const decisions: ProductEffectAuthority = {
    currentMember: () => current,
    task: (_teamId, taskId) => currentTask.taskId === taskId ? currentTask : null,
    recipient: (_runId, memberId) => currentRecipient.memberId === memberId ? currentRecipient : null,
  };
  const boundary = new HostedProductTaskEffectBoundary(() => db as never, decisions, {
    withExclusiveLock: (run) => run(),
    findExactReceipt: (id, hash) => {
      const found = canonical.get(id);
      if (found && found.fingerprint !== hash) throw new Error('canonical-idempotency-conflict');
      return found?.receipt ?? null;
    },
    writeOnce: (id, hash, request) => {
      if (canonical.has(id)) throw new Error('duplicate-canonical-write');
      const receipt = `${request.kind}_receipt`;
      canonical.set(id, { fingerprint: hash, receipt });
      writes++;
      if (request.kind === 'message') wakes++;
      if (throwAfterFileWrite) throw new Error('simulated-crash-after-fsync');
      return receipt;
    },
  }, { hasExactCall: () => attested });
  const common = { binding, authority, callID: 'call_test', messageID: 'message_test',
    signal: new AbortController().signal };
  const status: ProductEffectRequest = { ...common, kind: 'status', task, status: 'in_progress' };
  const message: ProductEffectRequest = { ...common, kind: 'message', recipient,
    text: 'Hello peer', taskRefs: [task] };
  return {
    db, boundary, status, message,
    setCurrent: (value: typeof current) => { current = value; },
    setTask: (value: typeof currentTask) => { currentTask = value; },
    setRecipient: (value: typeof currentRecipient) => { currentRecipient = value; },
    crashAfterFileWrite: () => { throwAfterFileWrite = true; },
    revokeAttestation: () => { attested = false; },
    counts: () => ({ writes, wakes }),
  };
}

describe('HostedProductTaskEffectBoundary', () => {
  it('rejects an Owner proposal without an independent exact FD3 call', () => {
    const f = fixture();
    f.revokeAttestation();
    expect(() => f.boundary.commit(f.status)).toThrow('unattested-call');
    expect(f.counts().writes).toBe(0);
  });

  it('rejects a stale exact run/session without a canonical write', () => {
    const f = fixture();
    f.setCurrent({ ...binding, ...authority, runId: 'run_replaced' });
    expect(() => f.boundary.commit(f.status)).toThrow('stale-member');
    expect(f.counts()).toEqual({ writes: 0, wakes: 0 });
  });

  it('rejects changed task generation or revision before status or comment writes', () => {
    const f = fixture();
    f.setTask({ ...task, revision: 'revision_new' });
    expect(() => f.boundary.commit(f.status)).toThrow('stale-task');
    expect(() => f.boundary.commit({ ...f.status, kind: 'comment', text: 'Progress' })).toThrow('stale-task');
    expect(f.counts().writes).toBe(0);
  });

  it('rejects a recipient replaced under the same display name', () => {
    const f = fixture();
    f.setRecipient({ ...recipient, memberId: 'member_replacement' });
    expect(() => f.boundary.commit(f.message)).toThrow('stale-recipient');
    expect(f.counts()).toEqual({ writes: 0, wakes: 0 });
  });

  it('recovers an ambiguous file success and does not write or wake twice', () => {
    const f = fixture();
    f.crashAfterFileWrite();
    expect(() => f.boundary.commit(f.message)).toThrow('simulated-crash-after-fsync');
    expect(f.db.prepare('SELECT count(*) AS count FROM hosted_product_task_effect_receipts')
      .get()).toEqual({ count: 0 });
    f.setCurrent({ ...binding, ...authority, runId: 'run_replaced' });
    expect(f.boundary.commit(f.message)).toBe('message_receipt');
    expect(f.boundary.commit(f.message)).toBe('message_receipt');
    expect(f.counts()).toEqual({ writes: 1, wakes: 1 });
    expect(() => f.boundary.commit({ ...f.message, text: 'Different message' }))
      .toThrow('idempotency-conflict');
  });
});
