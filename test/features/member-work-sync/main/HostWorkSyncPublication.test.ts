import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as atomic from '@agent-teams/task-change-ledger/review-io';
import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import { JsonMemberWorkSyncReportJournal } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncReportJournal';
import { compareAndWriteMemberWorkSyncJsonStatus } from '@features/member-work-sync/main/infrastructure/memberWorkSyncJsonStatusPersistence';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'TEST-work-sync-publication-')));
  roots.push(root);
  const paths = new MemberWorkSyncStorePaths(root);
  const scope = { teamName: 'test-owner', memberName: 'alice' };
  let current = true;
  function assertCurrent() {
    if (!current) throw new Error('TEST original authority revoked');
  }
  return {
    paths,
    scope,
    assertCurrent,
    revoke() {
      current = false;
    },
  };
}

it('Host token publication holds original physical fence through delayed atomic creation and refuses revoke without adopting', async () => {
  const f = await setup();
  const reached = deferred(),
    release = deferred();
  let held = false;
  const original = atomic.atomicCreateAsync;
  vi.spyOn(atomic, 'atomicCreateAsync').mockImplementation(async (...args) => {
    reached.resolve();
    await release.promise;
    return original(...args);
  });
  const token = new HmacMemberWorkSyncReportTokenAdapter(f.paths, {
    readCurrent: async () => ({ status: 'identified', identityId: 'TEST-fixed-incarnation' }),
    async withCurrentPublication(_team, _identity, operation) {
      held = true;
      try {
        f.assertCurrent();
        return { current: true, value: await operation(f.assertCurrent) };
      } finally {
        held = false;
      }
    },
  });
  const pending = token.create({
    ...f.scope,
    agendaFingerprint: 'TEST-agenda',
    issuedAt: '2026-10-23T00:00:00.000Z',
  });
  const refused = expect(pending).rejects.toThrow('TEST original authority revoked');
  await reached.promise;
  expect(held).toBe(true);
  f.revoke();
  release.resolve();
  await refused;
  expect(held).toBe(false);
  expect(existsSync(f.paths.getReportTokenSecretPath(f.scope.teamName))).toBe(false);
});

it('original canonical report journal cannot publish after authority revocation during awaited IO', async () => {
  const f = await setup();
  const reached = deferred(),
    release = deferred();
  const path = f.paths.getMemberReportsPath(f.scope.teamName, f.scope.memberName);
  const original = atomic.atomicWriteAsync;
  vi.spyOn(atomic, 'atomicWriteAsync').mockImplementation(async (target, data, options) => {
    if (target === path) {
      reached.resolve();
      await release.promise;
    }
    return original(target, data, options);
  });
  let projections = 0;
  const journal = new JsonMemberWorkSyncReportJournal(
    f.paths,
    (_team, operation) => operation(),
    async () => {
      projections++;
    },
    f.assertCurrent
  );
  const pending = journal.ensure({
    ...f.scope,
    intentId: 'TEST-original-command',
    incarnation: 'TEST-fixed-incarnation',
    requestDigest: 'TEST-request-digest',
    receivedAt: '2026-10-23T00:00:00.000Z',
    origin: 'online',
    request: {
      ...f.scope,
      state: 'still_working',
      agendaFingerprint: 'TEST-agenda',
      reportToken: 'TEST-original-token',
    },
  });
  await reached.promise;
  f.revoke();
  release.resolve();
  expect(await pending).toEqual({ state: 'write_failed' });
  expect(existsSync(path)).toBe(false);
  expect(projections).toBe(0);
});

it('original JSON CAS keeps commit unknown after its publication boundary loses the original guard', async () => {
  const f = await setup();
  await f.paths.ensureMemberWorkSyncDir(f.scope.teamName, f.scope.memberName);
  const path = f.paths.getMemberStatusPath(f.scope.teamName, f.scope.memberName);
  const status: MemberWorkSyncStatus = {
    ...f.scope,
    state: 'needs_sync',
    evaluatedAt: '2026-10-23T00:00:00.000Z',
    diagnostics: [],
    agenda: {
      ...f.scope,
      generatedAt: '2026-10-23T00:00:00.000Z',
      fingerprint: 'TEST-agenda',
      items: [],
      diagnostics: [],
    },
  };
  const original = atomic.atomicWriteAsync;
  vi.spyOn(atomic, 'atomicWriteAsync').mockImplementation((target, data, options) =>
    original(target, data, {
      ...options,
      beforeCommit: async () => {
        await options?.beforeCommit?.();
        f.revoke();
      },
    })
  );
  let projected = false;
  expect(
    await compareAndWriteMemberWorkSyncJsonStatus({
      path,
      expectedRaw: null,
      mutationId: 'TEST-original-mutation',
      nextStatus: status,
      assertCurrent: f.assertCurrent,
      project: async () => {
        projected = true;
      },
    })
  ).toEqual({
    committed: 'unknown',
    reason: 'commit_unknown',
    mutationId: 'TEST-original-mutation',
  });
  expect(projected).toBe(false);
  expect(existsSync(path)).toBe(false);
});
