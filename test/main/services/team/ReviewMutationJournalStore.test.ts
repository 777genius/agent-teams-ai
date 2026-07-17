import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let teamsBasePath: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
}));

const persistenceScope = {
  scopeKey: 'task-task-1',
  scopeToken: 'task:task-1:request:change-set',
};

function makeInput() {
  return {
    teamName: 'demo',
    persistenceScope,
    reviewScope: { teamName: 'demo', taskId: 'task-1' },
    kind: 'reject' as const,
    decisions: [
      {
        filePath: '/repo/file.ts',
        reviewKey: 'change-key',
        fileDecision: 'pending' as const,
        hunkDecisions: { 0: 'rejected' as const, 1: 'pending' as const },
        hunkContextHashes: { 0: 'context-a', 1: 'context-b' },
      },
    ],
    fileContents: [
      {
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        snippets: [],
        linesAdded: 1,
        linesRemoved: 1,
        isNewFile: false,
        originalFullContent: 'before',
        modifiedFullContent: 'after',
        contentSource: 'ledger-exact' as const,
      },
    ],
    persistedState: {
      hunkDecisions: { 'change-key:0': 'rejected' as const },
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    },
  };
}

describe('ReviewMutationJournalStore', () => {
  beforeEach(async () => {
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'review-mutation-journal-'));
  });

  afterEach(async () => {
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  it('durably tracks every forward-only phase until complete is removed', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());

    await expect(store.list('demo', persistenceScope)).resolves.toEqual([prepared]);
    const diskApplied = await store.transition(prepared, 'prepared', 'disk_applied');
    const decisionsCommitted = await store.transition(
      diskApplied,
      'disk_applied',
      'decisions_committed'
    );
    const complete = await store.transition(decisionsCommitted, 'decisions_committed', 'complete');
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([complete]);
    await store.remove(complete);
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([]);
  });

  it('persists a decision-only Redo record with no artificial disk step', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const action = {
      id: 'redo-hunk',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const prepared = await store.prepare({
      teamName: 'demo',
      persistenceScope,
      reviewScope: { teamName: 'demo', taskId: 'task-123' },
      kind: 'redo',
      decisions: [],
      fileContents: [],
      diskSteps: [],
      persistedState: {
        hunkDecisions: { 'file:0': 'accepted' },
        fileDecisions: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 4,
    });

    expect(prepared).toMatchObject({
      kind: 'redo',
      phase: 'prepared',
      diskSteps: [],
      expectedDecisionRevision: 4,
    });
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([prepared]);
  });

  it('keeps failed mutations visible until explicit scoped discard', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    await store.markFailed(prepared, new Error('disk failed'));

    await expect(store.list('demo', persistenceScope)).resolves.toMatchObject([
      { phase: 'prepared', blocked: true, failure: 'disk failed' },
    ]);
    await store.clearScope('demo', persistenceScope);
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([]);
  });

  it('refuses to create a second operation before the pending WAL is drained', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    await store.prepare(makeInput());

    await expect(store.prepare(makeInput())).rejects.toThrow(
      'A review mutation is already pending for this decision scope'
    );
  });

  it('rejects a record whose embedded id does not match its durable filename', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    const scopeDir = path.dirname(findRecordPath(teamsBasePath, prepared.id));
    const recordPath = path.join(scopeDir, `${prepared.id}.json`);
    const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as { id: string };
    parsed.id = 'different-id';
    await writeFile(recordPath, JSON.stringify(parsed), 'utf8');

    await expect(store.list('demo', persistenceScope)).rejects.toThrow(
      'Invalid review mutation journal record'
    );
  });

  it('fails closed on symbolic-link journal records', async () => {
    if (process.platform === 'win32') return;
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    const recordPath = findRecordPath(teamsBasePath, prepared.id);
    const externalPath = path.join(teamsBasePath, 'external.json');
    const payload = await readFile(recordPath, 'utf8');
    await writeFile(externalPath, payload, 'utf8');
    await rm(recordPath);
    await (await import('fs/promises')).symlink(externalPath, recordPath);

    await expect(store.list('demo', persistenceScope)).rejects.toThrow(
      'Unsafe review mutation journal symlink'
    );
  });
});

function findRecordPath(basePath: string, id: string): string {
  const scopeHash = createHash('sha256').update(persistenceScope.scopeToken).digest('hex');
  return path.join(
    basePath,
    'demo',
    'review-decisions',
    'mutation-journal',
    persistenceScope.scopeKey,
    scopeHash,
    `${id}.json`
  );
}
