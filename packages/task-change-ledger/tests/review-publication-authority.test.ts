import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewApplier } from '../dist/review/apply/index.js';
import {
  atomicCreateAsync,
  atomicWriteAsync,
  executeReviewFileTransaction,
  finalizeReviewFileTransaction,
  inspectReviewFileTransaction,
  prepareReviewFileTransaction,
} from '../dist/review/io/index.js';
import type { TestContext } from 'node:test';
import type { FileChangeWithContent } from '../dist/contracts.js';

function gate() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    wait: async () => {
      entered();
      await pending;
    },
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-review-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'work.txt');
  await writeFile(file, 'after\n');
  let current = true;
  const authority = {
    assertCurrent() {
      if (!current) throw new Error('TEST captured authority revoked');
    },
  };
  return {
    root,
    file,
    authority,
    revoke: () => {
      current = false;
    },
    restore: () => {
      current = true;
    },
  };
}
test('captured Applier guard after awaited WAL staging prevents a new disk publication', async (t) => {
  const f = await fixture(t),
    staged = gate();
  const applier = new ReviewApplier(f.authority);
  const file: FileChangeWithContent = {
    filePath: f.file,
    relativePath: 'work.txt',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    originalFullContent: 'before\n',
    modifiedFullContent: 'after\n',
    contentSource: 'ledger-exact',
  };
  const pending = applier.applyReviewDecisions(
    {
      teamName: 'test-authority',
      decisions: [{ filePath: f.file, fileDecision: 'rejected', hunkDecisions: {} }],
    },
    new Map([[f.file, file]]),
    { checkpointDiskTransitions: staged.wait }
  );
  await staged.ready;
  f.revoke();
  staged.release();
  const result = await pending;
  assert.equal(result.applied, 0);
  assert.ok(result.errors.length > 0);
  assert.equal(await readFile(f.file, 'utf8'), 'after\n');
});
test('revocation during before-detach await preserves original source bytes', async (t) => {
  const f = await fixture(t),
    staged = gate();
  const transaction = await prepareReviewFileTransaction(
    {
      kind: 'replace',
      sourcePath: f.file,
      targetPath: f.file,
      expectedContent: 'after\n',
      nextContent: 'before\n',
    },
    f.authority
  );
  const pending = executeReviewFileTransaction(transaction, {
    ...f.authority,
    beforeDetach: staged.wait,
  });
  await staged.ready;
  f.revoke();
  staged.release();
  await assert.rejects(pending, /authority revoked/);
  assert.equal(await readFile(f.file, 'utf8'), 'after\n');
});
test('revocation after an accepted detach stays partial; original transaction can resume without replacement intent', async (t) => {
  const f = await fixture(t),
    staged = gate();
  const target = join(f.root, 'renamed.txt');
  const transaction = await prepareReviewFileTransaction(
    {
      kind: 'move',
      sourcePath: f.file,
      targetPath: target,
      expectedContent: 'after\n',
      nextContent: 'before\n',
    },
    f.authority
  );
  const pending = executeReviewFileTransaction(transaction, {
    ...f.authority,
    beforePublish: staged.wait,
  });
  await staged.ready;
  f.revoke();
  staged.release();
  await assert.rejects(pending, /authority revoked/);
  assert.equal(existsSync(f.file), false);
  assert.equal(existsSync(target), false);
  assert.equal(await inspectReviewFileTransaction(transaction), 'detached');
  f.restore();
  await executeReviewFileTransaction(transaction, f.authority);
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  assert.equal(await inspectReviewFileTransaction(transaction), 'published');
});
test('atomic replace cannot publish after staging revocation and cleanup preserves an external temp replacement', async (t) => {
  const f = await fixture(t),
    staged = gate();
  const pending = atomicWriteAsync(f.file, 'new bytes\n', {
    ...f.authority,
    beforeCommit: staged.wait,
  });
  await staged.ready;
  const temp = join(f.root, (await readdir(f.root)).find((name) => name.startsWith('.tmp.'))!);
  unlinkSync(temp);
  writeFileSync(temp, 'TEST external replacement\n');
  f.revoke();
  staged.release();
  await assert.rejects(pending, /authority revoked/);
  assert.equal(await readFile(f.file, 'utf8'), 'after\n');
  assert.equal(await readFile(temp, 'utf8'), 'TEST external replacement\n');
});
test('guarded create rechecks after actual temp write and leaves an external replacement alone', async (t) => {
  const f = await fixture(t),
    target = join(f.root, 'new.txt');
  let external: string | undefined;
  await assert.rejects(
    atomicCreateAsync(target, 'new bytes\n', {
      assertCurrent() {
        f.authority.assertCurrent();
        const temp = readdirSync(f.root).find((name) => name.startsWith('.review-create.'));
        if (!temp) return;
        const path = join(f.root, temp);
        if (readFileSync(path, 'utf8') !== 'new bytes\n') return;
        unlinkSync(path);
        writeFileSync(path, 'TEST external replacement\n');
        external = path;
        f.revoke();
        f.authority.assertCurrent();
      },
    }),
    /authority revoked/
  );
  assert.equal(existsSync(target), false);
  assert.ok(external);
  assert.equal(await readFile(external, 'utf8'), 'TEST external replacement\n');
});
test('finalization refuses a raced artifact replacement instead of unlinking the replacement', async (t) => {
  const f = await fixture(t);
  const transaction = await prepareReviewFileTransaction(
    {
      kind: 'replace',
      sourcePath: f.file,
      targetPath: f.file,
      expectedContent: 'after\n',
      nextContent: 'before\n',
    },
    f.authority
  );
  await executeReviewFileTransaction(transaction, f.authority);
  const dir = join(
    f.root,
    (await readdir(f.root)).find((name) => name.startsWith('.review-txn-'))!
  );
  const artifact = join(dir, 'after.tmp');
  const pending = finalizeReviewFileTransaction(transaction, f.authority);
  unlinkSync(artifact);
  writeFileSync(artifact, 'TEST external replacement\n');
  await assert.rejects(pending);
  assert.equal(await readFile(artifact, 'utf8'), 'TEST external replacement\n');
  assert.equal(await readFile(f.file, 'utf8'), 'before\n');
});
