import { createHash } from 'crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
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

  it('fails closed for a symlinked mutation-journal scope', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const external = await mkdtemp(path.join(tmpdir(), 'external-review-journal-'));
    const sentinelPath = path.join(external, 'sentinel.json');
    try {
      await writeFile(sentinelPath, 'sentinel', 'utf8');
      const scopeParent = path.join(
        teamsBasePath,
        'demo',
        'review-decisions',
        'mutation-journal',
        persistenceScope.scopeKey
      );
      await mkdir(scopeParent, { recursive: true });
      await symlink(
        external,
        path.join(
          scopeParent,
          createHash('sha256').update(persistenceScope.scopeToken).digest('hex')
        ),
        'dir'
      );

      await expect(store.prepare(makeInput())).rejects.toThrow('Unsafe persistence directory');
      await expect(store.list('demo', persistenceScope)).rejects.toThrow(
        'Unsafe persistence directory'
      );
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('sentinel');
      await expect(readdir(external)).resolves.toEqual(['sentinel.json']);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
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

  it('durably unblocks the same failed record for an explicit retry', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    await store.markFailed(prepared, new Error('transient disk failure'));
    const [blocked] = await store.list('demo', persistenceScope);

    const unblocked = await store.unblock(blocked);

    expect(unblocked).toMatchObject({ id: prepared.id, phase: 'prepared' });
    expect(unblocked.blocked).toBeUndefined();
    expect(unblocked.failure).toBeUndefined();
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([unblocked]);
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

  it('quarantines an unreadable WAL scope for explicit recovery', async () => {
    const { CorruptReviewMutationJournalError, ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    const recordPath = findRecordPath(teamsBasePath, prepared.id);
    await writeFile(recordPath, '{broken-wal', 'utf8');

    await expect(store.list('demo', persistenceScope)).rejects.toBeInstanceOf(
      CorruptReviewMutationJournalError
    );
    await expect(store.inspectForRecoveryDiscard('demo', persistenceScope)).resolves.toEqual({
      records: [],
      corruptRecordCount: 1,
    });
    const quarantinePath = await store.quarantineCorruptScope('demo', persistenceScope);

    expect(quarantinePath).toContain('.corrupt-');
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([]);
    await expect(readdir(path.dirname(path.dirname(recordPath)))).resolves.toContain(
      path.basename(quarantinePath!)
    );
  });

  it('does not quarantine a valid pending disk mutation beside a corrupt record', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    const recordPath = findRecordPath(teamsBasePath, prepared.id);
    const corruptId = '11111111-1111-4111-8111-111111111111';
    await writeFile(path.join(path.dirname(recordPath), `${corruptId}.json`), '{broken', 'utf8');

    await expect(store.inspectForRecoveryDiscard('demo', persistenceScope)).resolves.toMatchObject({
      records: [{ id: prepared.id }],
      corruptRecordCount: 1,
    });
    await expect(store.quarantineCorruptScope('demo', persistenceScope)).rejects.toThrow(
      'valid pending disk mutation'
    );
    await expect(readFile(recordPath, 'utf8')).resolves.toContain(prepared.id);
  });

  it('round-trips only validated SHA-256 decision postimages', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const store = new ReviewMutationJournalStore();
    const prepared = await store.prepare(makeInput());
    const checkpointed = await store.checkpoint({
      ...prepared,
      decisionStatuses: ['applied'],
      decisionPostimages: [
        [
          {
            filePath: '/repo/file.ts',
            sha256: createHash('sha256').update('after').digest('hex'),
          },
        ],
      ],
      decisionTransitions: [
        [
          {
            filePath: '/repo/file.ts',
            beforeContent: 'before',
            afterContent: 'after',
          },
        ],
      ],
    });
    await expect(store.list('demo', persistenceScope)).resolves.toEqual([checkpointed]);

    const recordPath = findRecordPath(teamsBasePath, prepared.id);
    const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as {
      decisionPostimages: { sha256: string | null }[][];
      decisionTransitions: { beforeContent: unknown }[][];
    };
    parsed.decisionPostimages[0]![0]!.sha256 = 'not-a-digest';
    await writeFile(recordPath, JSON.stringify(parsed), 'utf8');
    await expect(store.list('demo', persistenceScope)).rejects.toThrow(
      'Invalid review mutation journal record'
    );

    parsed.decisionPostimages[0]![0]!.sha256 = createHash('sha256').update('after').digest('hex');
    parsed.decisionTransitions[0]![0]!.beforeContent = 42;
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
