import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewMutationJournalStore } from '../dist/review/storage/ReviewMutationJournalStore.js';
import { ReviewDecisionStore } from '../dist/review/storage/ReviewDecisionStore.js';
import { ReviewMutationCoordinator } from '../dist/review/writer/ReviewMutationCoordinator.js';
import { createReviewCommandJournal } from '../dist/review/writer/reviewCommandJournal.js';
import type { ReviewCommandCommitProof } from '../dist/review/writer/reviewCommandJournal.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-original-review-wal-')));
  roots.push(root);
  const file = join(root, 'workspace.txt');
  await writeFile(file, 'before\n');
  const journal = new ReviewMutationJournalStore(root),
    decisions = new ReviewDecisionStore(root);
  const origin = { taskId: 'TEST-task', memberName: 'lead' };
  const correlation = { commandId: 'TEST-original', fingerprint: 'a'.repeat(64), origin };
  const scope = { scopeKey: 'task-TEST-task', scopeToken: 'TEST-original-scope' };
  const state = {
    hunkDecisions: {},
    fileDecisions: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
  };
  const input = {
    teamName: 'test-team',
    persistenceScope: scope,
    reviewScope: { teamName: 'test-team', ...origin },
    kind: 'undo' as const,
    decisions: [],
    fileContents: [],
    diskSteps: [],
    persistedState: state,
    expectedDecisionRevision: 0,
  };
  return { root, file, journal, decisions, correlation, scope, state, input };
}
it('retains complete original WAL until receipt publication succeeds, then cold resume never repeats disk or decision steps', async () => {
  const f = await fixture();
  let writes = 0,
    commits = 0,
    publishes = 0;
  const proofs: ReviewCommandCommitProof[] = [];
  const port = createReviewCommandJournal(
    f.journal,
    f.decisions,
    {
      capture: () => f.correlation,
      committed(proof) {
        publishes++;
        if (publishes === 1) throw new Error('TEST receipt publication failed');
        proofs.push(proof);
      },
    },
    () => {}
  );
  const coordinator = new ReviewMutationCoordinator(port);
  await assert.rejects(
    coordinator.execute(f.input, {
      async applyDisk(record) {
        writes++;
        await writeFile(f.file, 'after\n');
        return record;
      },
      async commitDecisions(record) {
        commits++;
        await f.decisions.save('test-team', f.scope.scopeKey, {
          scopeToken: f.scope.scopeToken,
          ...f.state,
          expectedRevision: 0,
          mutationId: record.id,
        });
      },
    }),
    /receipt publication failed/
  );
  const retained = await f.journal.list('test-team', f.scope);
  assert.strictEqual(retained.length, 1);
  assert.strictEqual(retained[0]?.phase, 'complete');
  assert.deepStrictEqual(retained[0]?.commandReceipt, f.correlation);
  assert.strictEqual(await readFile(f.file, 'utf8'), 'after\n');
  const coldJournal = new ReviewMutationJournalStore(f.root),
    coldDecisions = new ReviewDecisionStore(f.root);
  const cold = new ReviewMutationCoordinator(
    createReviewCommandJournal(
      coldJournal,
      coldDecisions,
      {
        capture: () => {
          throw new Error('Recovery must use persisted original identity');
        },
        committed(proof) {
          proofs.push(proof);
        },
      },
      () => {}
    )
  );
  await cold.resume(retained[0]!, {
    async applyDisk() {
      throw new Error('Disk step must not rerun');
    },
    async commitDecisions() {
      throw new Error('Decision step must not rerun');
    },
  });
  assert.strictEqual(writes, 1);
  assert.strictEqual(commits, 1);
  assert.strictEqual(proofs.length, 1);
  assert.partialDeepStrictEqual(proofs[0], {
    correlation: f.correlation,
    walId: retained[0]!.id,
    decisionRevision: 1,
    kind: 'undo',
  });
  assert.deepStrictEqual(await coldJournal.list('test-team', f.scope), []);
});
it('refuses false commit provenance and an absent original owner without deleting the retained WAL', async () => {
  const f = await fixture();
  let called = 0;
  const port = createReviewCommandJournal(
    f.journal,
    f.decisions,
    {
      capture: () => f.correlation,
      committed() {
        called++;
      },
    },
    () => {}
  );
  let record = await port.prepare(f.input);
  record = await f.journal.transition(record, 'prepared', 'disk_applied');
  record = await f.journal.transition(record, 'disk_applied', 'decisions_committed');
  record = await f.journal.transition(record, 'decisions_committed', 'complete');
  await f.decisions.save('test-team', f.scope.scopeKey, {
    scopeToken: f.scope.scopeToken,
    ...f.state,
    expectedRevision: 0,
    mutationId: 'TEST-other-mutation',
  });
  await assert.rejects(port.remove(record), /proof is unavailable/);
  assert.strictEqual(called, 0);
  const absent = createReviewCommandJournal(f.journal, f.decisions, undefined, () => {});
  await assert.rejects(absent.remove(record), /Original review command owner/);
  assert.strictEqual((await f.journal.list('test-team', f.scope)).length, 1);
});
it('preserves ordinary Desktop WAL behavior when no original Host correlation exists', async () => {
  const f = await fixture();
  const coordinator = new ReviewMutationCoordinator(
    createReviewCommandJournal(f.journal, f.decisions, undefined, () => {})
  );
  await coordinator.execute(f.input, {
    async applyDisk(record) {
      return record;
    },
    async commitDecisions(record) {
      await f.decisions.save('test-team', f.scope.scopeKey, {
        scopeToken: f.scope.scopeToken,
        ...f.state,
        expectedRevision: 0,
        mutationId: record.id,
      });
    },
  });
  assert.deepStrictEqual(await f.journal.list('test-team', f.scope), []);
  assert.strictEqual(
    (await f.decisions.load('test-team', f.scope.scopeKey, f.scope.scopeToken))?.revision,
    1
  );
});
