import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { TestContext } from 'node:test';
import type {
  ReviewWriter,
  ReviewWriterOptions,
  ReviewChangesPort,
} from '@agent-teams/task-change-ledger/review-writer';
import type { FileChangeSummary } from '@agent-teams/task-change-ledger/contracts';
import { createReviewWriter } from '@agent-teams/task-change-ledger/review-writer';
import { ReviewApplier } from '@agent-teams/task-change-ledger/review-apply';
import { isWindowsReservedFileName } from '../dist/review/writer/reviewGuards.js';

test('Windows reserved-name normalization preserves suffix and stem boundaries on long names', () => {
  for (const name of ['con', '\tNUL.txt\u00a0', ' COM1 . ', 'LPT9... ']) {
    assert.equal(isWindowsReservedFileName(name), true);
  }
  for (const name of ['console', 'COM10', 'COM1 .txt', 'x.con', ' . ', `${' .'.repeat(500_000)}!`]) {
    assert.equal(isWindowsReservedFileName(name), false);
  }
  assert.equal(isWindowsReservedFileName(`NUL${' .'.repeat(500_000)}`), true);
});
function exactLedgerSnippet(
  snippet: FileChangeSummary['snippets'][number], before: string, after: string
): FileChangeSummary['snippets'][number] {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { ...snippet, ledger: {
    eventId: snippet.toolUseId, source: 'ledger-snapshot', confidence: 'high',
    originalFullContent: before, modifiedFullContent: after,
    beforeHash: hash(before), afterHash: hash(after), operation: 'modify',
    beforeState: { exists: true, sha256: hash(before) },
    afterState: { exists: true, sha256: hash(after) },
  } };
}
async function fixture(t: TestContext, exactLedger = false) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-portable-review-writer-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const filePath = join(workspace, 'test.txt');
  await writeFile(filePath, 'after\n');
  const snippets: FileChangeSummary['snippets'] = [
    {
      toolUseId: 'TEST-edit',
      filePath,
      toolName: 'Edit',
      type: 'edit',
      oldString: 'before',
      newString: 'after',
      replaceAll: false,
      timestamp: '2026-10-23T00:00:00Z',
      isError: false,
    },
  ];
  if (exactLedger) snippets[0] = exactLedgerSnippet(snippets[0]!, 'before\n', 'after\n');
  const file: FileChangeSummary = {
    filePath,
    relativePath: 'test.txt',
    snippets,
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
  const changes: ReviewChangesPort = {
    async getAgentChanges(teamName, memberName) {
      return {
        teamName,
        memberName,
        files: [file],
        totalLinesAdded: 1,
        totalLinesRemoved: 1,
        totalFiles: 1,
        computedAt: '2026-10-23T00:00:00Z',
      };
    },
    async getTaskChanges() {
      throw new Error('Unexpected task lookup');
    },
  };
  const instances: ReviewWriter[] = [];
  const invalidations: string[] = [];
  const make = async (name: string, overrides: Partial<ReviewWriterOptions> = {}) => {
    const teamsRoot = join(root, name);
    await mkdir(teamsRoot);
    const writer = createReviewWriter({
      teamsRoot,
      changes,
      content: {
        async getFileContent() {
          return {
            ...file,
            originalFullContent: 'before\n',
            modifiedFullContent: 'after\n',
            contentSource: exactLedger ? 'ledger-snapshot' : 'disk-current',
          };
        },
        invalidateFile(path) {
          invalidations.push(path);
        },
      },
      authorization: {
        assertTeam(teamName) {
          assert.equal(teamName, 'test-review');
        },
        async getConfig() {
          return { projectPath: workspace };
        },
      },
      applier: new ReviewApplier(),
      processStartProbe: async () => 1,
      ...overrides,
    });
    instances.push(writer);
    return writer;
  };
  t.after(async () => {
    for (const writer of instances) writer.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, filePath, snippets, file, make, invalidations };
}
test('captured instances cannot share displayed tokens and non-ledger previews cannot authorize Apply', async (t: TestContext) => {
  const f = await fixture(t),
    a = await f.make('owner-a'),
    b = await f.make('owner-b');
  const shown = await a.getFileContent('test-review', 'alice', f.filePath, f.snippets);
  assert.ok(shown.reviewSnapshotToken);
  const request = {
    teamName: 'test-review',
    memberName: 'alice',
    decisions: [
      {
        filePath: f.filePath,
        fileDecision: 'rejected',
        hunkDecisions: {},
        contentSnapshotToken: shown.reviewSnapshotToken,
      },
    ],
  };
  await assert.rejects(b.applyDecisions(request), /Displayed review snapshot is stale/);
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
  const result = await a.applyDecisions(request);
  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.code, 'unavailable');
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
  assert.ok(f.invalidations.includes(f.filePath));
  a.dispose();
  await assert.rejects(
    a.getFileContent('test-review', 'alice', f.filePath, f.snippets),
    /disposed/
  );
});
test('decision queues/stores bind the explicit owner root and a foreign Team fails before persistence', async (t: TestContext) => {
  const f = await fixture(t),
    a = await f.make('owner-a'),
    b = await f.make('owner-b');
  assert.deepEqual(
    await a.saveDecisions('test-review', 'agent-alice', 'TEST-scope', {}, {}, null, [], 0, []),
    { revision: 1 }
  );
  assert.equal((await a.loadDecisions('test-review', 'agent-alice', 'TEST-scope'))!.revision, 1);
  assert.equal(await b.loadDecisions('test-review', 'agent-alice', 'TEST-scope'), null);
  await assert.rejects(
    a.saveDecisions('foreign-team', 'agent-alice', 'TEST-scope', {}, {}, null, [], 0, [])
  );
  assert.equal(await b.loadDecisions('test-review', 'agent-alice', 'TEST-scope'), null);
});
test('owner revocation across an awaited root lookup prevents content and disk effects', async (t: TestContext) => {
  const f = await fixture(t);
  let current = true,
    release!: () => void;
  let reads = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = await f.make('owner-a', {
    authorization: {
      assertTeam(teamName) {
        assert.equal(teamName, 'test-review');
      },
      assertCurrent() {
        assert.ok(current, 'original captured owner revoked');
      },
      async getConfig() {
        await waiting;
        return { projectPath: f.workspace };
      },
    },
    content: {
      async getFileContent() {
        reads++;
        throw new Error('Unexpected content read');
      },
      invalidateFile() {
        throw new Error('Unexpected invalidation');
      },
    },
  });
  const pending = a.getFileContent('test-review', 'alice', f.filePath, f.snippets);
  current = false;
  release();
  await assert.rejects(pending, /original captured owner revoked/);
  assert.equal(reads, 0);
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
});

test('an absent optional Desktop applier fails locally at first use and cannot reuse another owner', async (t: TestContext) => {
  const f = await fixture(t);
  await f.make('with-applier');
  const missing = await f.make('missing-applier', { applier: null });
  assert.equal(await missing.loadDecisions('test-review', 'agent-alice', 'TEST-scope'), null);
  await assert.rejects(missing.previewReject(f.filePath, 'before\n', 'after\n', [], []), {
    message: 'ReviewApplierService not initialized',
  });
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
});

test('unqualified native create cannot enter Apply or replay an already prepared delete through recovery', async (t: TestContext) => {
  const f = await fixture(t);
  f.snippets[0]!.ledger = {
    eventId: 'TEST-old-native',
    nativeCapture: 'unqualified',
    source: 'ledger-snapshot',
    confidence: 'low',
    originalFullContent: null,
    modifiedFullContent: null,
    beforeHash: null,
    afterHash: 'TEST-hash',
    operation: 'create',
    beforeState: { exists: false },
    afterState: { exists: true, sha256: 'TEST-hash' },
  };
  const writer = await f.make('native-recovery');
  await assert.rejects(
    writer.applyDecisions({
      teamName: 'test-review',
      memberName: 'alice',
      decisions: [{ filePath: f.filePath, fileDecision: 'rejected', hunkDecisions: {} }],
    }),
    /Native file attribution is unqualified/
  );
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
  const { ReviewMutationJournalStore } =
    await import('../dist/review/storage/ReviewMutationJournalStore.js');
  const journal = new ReviewMutationJournalStore(join(f.root, 'native-recovery'));
  const persistenceScope = { scopeKey: 'agent-alice', scopeToken: 'TEST-native-recovery' };
  await journal.prepare({
    teamName: 'test-review',
    persistenceScope,
    reviewScope: { teamName: 'test-review', memberName: 'alice' },
    kind: 'undo',
    decisions: [],
    fileContents: [],
    expectedDecisionRevision: 0,
    persistedState: {
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    },
    diskSteps: [
      {
        id: 'TEST-prepared-delete',
        type: 'delete',
        filePath: f.filePath,
        expectedContent: 'after\n',
        status: 'pending',
      },
    ],
  });
  await assert.rejects(
    writer.retryReviewMutationRecovery({
      scope: { teamName: 'test-review', memberName: 'alice' },
      decisionPersistenceScope: persistenceScope,
    }),
    /Native file attribution is unqualified/
  );
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
  assert.equal((await journal.list('test-review', persistenceScope))[0]!.phase, 'prepared');
});

test('manual saves release their acknowledged transaction link before a captured writer reopens the same file', async (t: TestContext) => {
  const f = await fixture(t),
    first = await f.make('manual-first');
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await first.saveEditedFile(scope, f.filePath, 'TEST manual first\n', 'after\n');
  assert.equal((await lstat(f.filePath)).nlink, 1);
  first.dispose();
  const reopened = await f.make('manual-reopened');
  await reopened.saveEditedFile(scope, f.filePath, 'TEST manual second\n', 'TEST manual first\n');
  assert.equal(await readFile(f.filePath, 'utf8'), 'TEST manual second\n');
  assert.equal((await lstat(f.filePath)).nlink, 1);
  assert.deepEqual(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
    []
  );
});

test('manual-save cleanup failure keeps owned transaction proof for an exact retry instead of admitting a replacement write', async (t: TestContext) => {
  const f = await fixture(t),
    applier = new ReviewApplier();
  const interrupted = await f.make('manual-interrupted', {
    applier: {
      ...applier,
      async finalizeEditedFileTransaction() {
        throw new Error('TEST cleanup interrupted');
      },
    },
  });
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await assert.rejects(
    interrupted.saveEditedFile(scope, f.filePath, 'TEST original postimage\n', 'after\n'),
    /TEST cleanup interrupted/
  );
  assert.equal(await readFile(f.filePath, 'utf8'), 'TEST original postimage\n');
  assert.ok((await lstat(f.filePath)).nlink > 1);
  assert.equal(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')).length,
    1
  );
  interrupted.dispose();
  const reopened = await f.make('manual-recovery');
  await assert.rejects(
    reopened.saveEditedFile(scope, f.filePath, 'TEST replacement\n', 'TEST original postimage\n'),
    /linked/
  );
  await reopened.saveEditedFile(scope, f.filePath, 'TEST original postimage\n', 'after\n');
  assert.equal(await readFile(f.filePath, 'utf8'), 'TEST original postimage\n');
  assert.equal((await lstat(f.filePath)).nlink, 1);
});

test('manual delete removes a recreated same-byte file after the first delete was acknowledged', async (t: TestContext) => {
  const f = await fixture(t),
    first = await f.make('delete-first');
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await first.deleteEditedFile(scope, f.filePath, 'after\n');
  await assert.rejects(readFile(f.filePath, 'utf8'), { code: 'ENOENT' });
  first.dispose();
  await writeFile(f.filePath, 'after\n');
  const reopened = await f.make('delete-reopened');
  await reopened.deleteEditedFile(scope, f.filePath, 'after\n');
  await assert.rejects(readFile(f.filePath, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
    []
  );
});

test('manual-delete cleanup failure keeps original deletion proof until an exact retry finalizes it', async (t: TestContext) => {
  const f = await fixture(t),
    applier = new ReviewApplier();
  const interrupted = await f.make('delete-interrupted', {
    applier: {
      ...applier,
      async finalizeEditedFileTransaction() {
        throw new Error('TEST delete cleanup interrupted');
      },
    },
  });
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await assert.rejects(
    interrupted.deleteEditedFile(scope, f.filePath, 'after\n'),
    /TEST delete cleanup interrupted/
  );
  await assert.rejects(readFile(f.filePath, 'utf8'), { code: 'ENOENT' });
  assert.equal(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')).length,
    1
  );
  interrupted.dispose();
  const reopened = await f.make('delete-recovery');
  await reopened.deleteEditedFile(scope, f.filePath, 'after\n');
  await assert.rejects(readFile(f.filePath, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
    []
  );
});

test('interrupted manual deletion cannot acknowledge a byte-identical independently recreated file', async (t: TestContext) => {
  const f = await fixture(t),
    applier = new ReviewApplier();
  const interrupted = await f.make('delete-foreign-interrupted', {
    applier: {
      ...applier,
      async finalizeEditedFileTransaction() {
        throw new Error('TEST delete interrupted');
      },
    },
  });
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await assert.rejects(
    interrupted.deleteEditedFile(scope, f.filePath, 'after\n'),
    /TEST delete interrupted/
  );
  await writeFile(f.filePath, 'after\n');
  const reopened = await f.make('delete-foreign-reopened');
  await assert.rejects(
    reopened.deleteEditedFile(scope, f.filePath, 'after\n'),
    /not durably published/
  );
  assert.equal(await readFile(f.filePath, 'utf8'), 'after\n');
  assert.equal(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')).length,
    1
  );
});

for (const method of ['rejectHunks', 'rejectFile'] as const) {
  test(`standalone ${method} settles the actual merged transition before the next captured edit`, async (t: TestContext) => {
    const f = await fixture(t);
    const unchanged = Array.from({ length: 14 }, (_, i) => `unchanged ${i}\n`).join('');
    const original = `before\n${unchanged}tail\n`;
    const modified = `after\n${unchanged}tail\n`;
    const current = `${modified}TEST independent edit\n`;
    await writeFile(f.filePath, current);
    const first = await f.make(`standalone-${method}`, {
      content: {
        async getFileContent() {
          return {
            ...f.file,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-snapshot',
          };
        },
        invalidateFile() {},
      },
    });
    const scope = { teamName: 'test-review', memberName: 'alice' };
    const result =
      method === 'rejectHunks'
        ? await first.rejectHunks(scope, f.filePath, [0])
        : await first.rejectFile(scope, f.filePath);
    assert.equal(result.success, true);
    const expected = `${original}TEST independent edit\n`;
    assert.equal(await readFile(f.filePath, 'utf8'), expected);
    assert.equal((await lstat(f.filePath)).nlink, 1);
    first.dispose();
    const reopened = await f.make(`standalone-${method}-reopened`);
    await reopened.saveEditedFile(scope, f.filePath, 'TEST next edit\n', expected);
    assert.equal(await readFile(f.filePath, 'utf8'), 'TEST next edit\n');
    assert.deepEqual(
      (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
      []
    );
  });
}

test('standalone Apply without a persistence scope settles actual publications before a reopened manual edit', async (t: TestContext) => {
  const f = await fixture(t, true),
    first = await f.make('standalone-apply');
  const shown = await first.getFileContent('test-review', 'alice', f.filePath, f.snippets);
  const result = await first.applyDecisions({
    teamName: 'test-review',
    memberName: 'alice',
    decisions: [
      {
        filePath: f.filePath,
        fileDecision: 'rejected',
        hunkDecisions: {},
        contentSnapshotToken: shown.reviewSnapshotToken,
      },
    ],
  });
  assert.deepEqual(result, { applied: 1, skipped: 0, conflicts: 0, errors: [] });
  assert.equal(await readFile(f.filePath, 'utf8'), 'before\n');
  assert.equal((await lstat(f.filePath)).nlink, 1);
  first.dispose();
  const reopened = await f.make('standalone-apply-reopened');
  await reopened.saveEditedFile(
    { teamName: 'test-review', memberName: 'alice' },
    f.filePath,
    'TEST after Apply\n',
    'before\n'
  );
  assert.equal(await readFile(f.filePath, 'utf8'), 'TEST after Apply\n');
});

for (const direction of ['restore', 'reapply'] as const) {
  test(`standalone rename ${direction} settles its captured move before another review mutation`, async (t: TestContext) => {
    const f = await fixture(t),
      oldPath = join(f.workspace, 'old.txt');
    const original = 'before\n',
      modified = 'after\n';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const relation = { kind: 'rename' as const, oldPath, newPath: f.filePath };
    f.file.snippets = [
      {
        ...f.snippets[0]!,
        filePath: oldPath,
        toolUseId: 'TEST-rename-old',
        ledger: {
          eventId: 'TEST-rename-old',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: original,
          modifiedFullContent: null,
          beforeHash: hash(original),
          afterHash: null,
          operation: 'delete',
          relation,
          beforeState: { exists: true, sha256: hash(original) },
          afterState: { exists: false },
        },
      },
      {
        ...f.snippets[0]!,
        toolUseId: 'TEST-rename-new',
        ledger: {
          eventId: 'TEST-rename-new',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: null,
          modifiedFullContent: modified,
          beforeHash: null,
          afterHash: hash(modified),
          operation: 'create',
          relation,
          beforeState: { exists: false },
          afterState: { exists: true, sha256: hash(modified) },
        },
      },
    ];
    if (direction === 'restore') {
      await rm(f.filePath);
      await writeFile(oldPath, original);
    }
    const writer = await f.make(`standalone-rename-${direction}`, {
      content: {
        async getFileContent() {
          return {
            ...f.file,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-snapshot',
          };
        },
        invalidateFile() {},
      },
    });
    const scope = { teamName: 'test-review', memberName: 'alice' };
    const expectation = {
      eventId: 'TEST-rename-old',
      beforeHash: hash(original),
      afterHash: null,
      relation,
    };
    const result =
      direction === 'restore'
        ? await writer.restoreRejectedRename(scope, f.filePath, expectation)
        : await writer.reapplyRejectedRename(scope, f.filePath, expectation);
    assert.equal(result.success, true);
    const publishedPath = direction === 'restore' ? f.filePath : oldPath;
    const expected = direction === 'restore' ? modified : original;
    assert.equal(await readFile(publishedPath, 'utf8'), expected);
    assert.equal((await lstat(publishedPath)).nlink, 1);
    assert.deepEqual(
      (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
      []
    );
    await writer.saveEditedFile(scope, publishedPath, 'TEST after rename\n', expected);
    assert.equal(await readFile(publishedPath, 'utf8'), 'TEST after rename\n');
  });
}

test('standalone reject finalizer failure retains the exact actual preimage and does not acknowledge success', async (t: TestContext) => {
  const f = await fixture(t),
    applier = new ReviewApplier();
  let calls = 0;
  const writer = await f.make('standalone-reject-interrupted', {
    applier: {
      ...applier,
      async finalizeReviewDiskTransitions(transitions) {
        calls++;
        assert.equal(transitions.length, 1);
        assert.equal(transitions[0]!.beforeContent, 'after\n');
        assert.equal(transitions[0]!.afterContent, 'before\n');
        assert.equal(transitions[0]!.operation, 'replace');
        assert.ok(transitions[0]!.transactionId);
        throw new Error('TEST standalone finalization interrupted');
      },
    },
  });
  const scope = { teamName: 'test-review', memberName: 'alice' };
  await assert.rejects(
    writer.rejectFile(scope, f.filePath),
    /TEST standalone finalization interrupted/
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(f.filePath, 'utf8'), 'before\n');
  assert.equal((await lstat(f.filePath)).nlink, 2);
  await assert.rejects(
    writer.saveEditedFile(scope, f.filePath, 'TEST replacement intent\n', 'before\n'),
    /symbolic or multiply-linked/
  );
  assert.equal(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')).length,
    1
  );
});

test('standalone Apply preserves known partial errors while settling only its completed file', async (t: TestContext) => {
  const f = await fixture(t, true),
    otherPath = join(f.workspace, 'conflicting.txt');
  await writeFile(otherPath, 'TEST external conflict\n');
  const other: FileChangeSummary = {
    ...f.file,
    filePath: otherPath,
    relativePath: 'conflicting.txt',
    snippets: [
      exactLedgerSnippet({
        ...f.snippets[0]!, toolUseId: 'TEST-other-edit', filePath: otherPath,
        oldString: 'before other', newString: 'after other',
      }, 'before other\n', 'after other\n'),
    ],
  };
  const writer = await f.make('standalone-partial', {
    changes: {
      async getAgentChanges(teamName, memberName) {
        return {
          teamName,
          memberName,
          files: [f.file, other],
          totalLinesAdded: 2,
          totalLinesRemoved: 2,
          totalFiles: 2,
          computedAt: '2026-10-23T00:00:00Z',
        };
      },
      async getTaskChanges() {
        throw new Error('Unexpected Task lookup');
      },
    },
    content: {
      async getFileContent(_team, _member, filePath) {
        return filePath === otherPath
          ? {
              ...other,
              originalFullContent: 'before other\n',
              modifiedFullContent: 'after other\n',
              contentSource: 'ledger-snapshot',
            }
          : {
              ...f.file,
              originalFullContent: 'before\n',
              modifiedFullContent: 'after\n',
              contentSource: 'ledger-snapshot',
            };
      },
      invalidateFile() {},
    },
  });
  const first = await writer.getFileContent('test-review', 'alice', f.filePath, f.snippets);
  const second = await writer.getFileContent('test-review', 'alice', otherPath, other.snippets);
  const result = await writer.applyDecisions({
    teamName: 'test-review',
    memberName: 'alice',
    decisions: [
      {
        filePath: f.filePath,
        fileDecision: 'rejected',
        hunkDecisions: {},
        contentSnapshotToken: first.reviewSnapshotToken,
      },
      {
        filePath: otherPath,
        fileDecision: 'rejected',
        hunkDecisions: {},
        contentSnapshotToken: second.reviewSnapshotToken,
      },
    ],
  });
  assert.equal(result.applied, 1);
  assert.equal(result.conflicts, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.filePath, otherPath);
  assert.equal(await readFile(otherPath, 'utf8'), 'TEST external conflict\n');
  assert.equal(await readFile(f.filePath, 'utf8'), 'before\n');
  assert.equal((await lstat(f.filePath)).nlink, 1);
  assert.deepEqual(
    (await readdir(f.workspace)).filter((name) => name.startsWith('.review-txn-')),
    []
  );
});

test('standalone reject preserves a structured failure and original proof after an uncertain detach', async (t: TestContext) => {
  const f = await fixture(t);
  let finalizations = 0;
  const applier = new ReviewApplier({
    assertCurrent() {
      if (!existsSync(f.filePath)) throw new Error('TEST authority lost after detach');
    },
  });
  const writer = await f.make('standalone-detach-fault', {
    applier: {
      ...applier,
      async finalizeReviewDiskTransitions() {
        finalizations++;
      },
    },
  });
  const result = await writer.rejectFile(
    { teamName: 'test-review', memberName: 'alice' },
    f.filePath
  );
  assert.equal(result.success, false);
  assert.match(result.conflictDescription!, /TEST authority lost after detach/);
  assert.equal(finalizations, 0);
  assert.equal(existsSync(f.filePath), false);
  const transactions = (await readdir(f.workspace)).filter((name) =>
    name.startsWith('.review-txn-')
  );
  assert.equal(transactions.length, 1);
  assert.equal(await readFile(join(f.workspace, transactions[0]!, 'detached'), 'utf8'), 'after\n');
});
