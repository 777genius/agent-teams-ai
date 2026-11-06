import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { assertNativeReviewPersistence } from './desktop-native-review-continuation-persistence.ts';
import { readNativeReviewContinuationSource } from './desktop-native-review-continuation-source.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const expectedBeforeReloadSha = '8a618f8264224ec6391e17ed7398d3ed9a8f26f3ca779bcc8cd0b57b1df2667e';

/** Reconstruct only the explicitly printed expected fields, accepted only by its independent SHA. */
export function reconstructNativeReviewExpectedSnapshot(
  failure: string,
  observed: Row,
  filePath: string
): Row {
  const expectedSha = /-\s+sha256: '([a-f0-9]{64})'/.exec(failure)?.[1];
  assert.equal(expectedSha, expectedBeforeReloadSha);
  assert.ok(failure.includes(`-         'path:${filePath}': {}`));
  const revision = Number(/-\s+revision: (\d+),/.exec(failure)?.[1]);
  const time = /-\s+updatedAt: '([^']+)'/.exec(failure)?.[1];
  assert.equal(revision, 5);
  assert.equal(time, '2026-10-23T01:11:54.038Z');
  const value = structuredClone(record(observed.value));
  value.hunkContextHashesByFile = { [`path:${filePath}`]: {} };
  value.revision = revision;
  value.updatedAt = time;
  const reconstructedBytes = JSON.stringify(value, null, 2);
  assert.equal(
    sha(reconstructedBytes),
    expectedSha,
    'reconstructed pre-reload JSON must reproduce independently printed SHA'
  );
  return { path: observed.path, sha256: expectedSha, value };
}

async function inventory(root: string): Promise<Row[]> {
  const rows: Row[] = [];
  let size = 0;
  const visit = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        info = await lstat(path);
      assert.ok(rows.length < 8192);
      if (info.isSymbolicLink())
        rows.push({ path: relative(root, path), link: await readlink(path) });
      else if (info.isDirectory()) {
        rows.push({ path: relative(root, path), directory: true });
        await visit(path);
      } else {
        assert.ok(info.isFile() && info.size <= 16 * 1024 * 1024);
        size += info.size;
        assert.ok(size <= 256 * 1024 * 1024);
        rows.push({ path: relative(root, path), size: info.size, sha256: await fileDigest(path) });
      }
    }
  };
  await visit(root);
  return rows;
}
async function retained(artifact: string, path: string): Promise<Buffer> {
  const manifest = await json(join(artifact, 'manifest.json'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 1024);
  const entries = manifest.files.map(record).filter((row) => row.path === path);
  assert.equal(entries.length, 1);
  const bytes = await readFile(join(artifact, path));
  assert.equal(sha(bytes), entries[0]!.sha256);
  assert.equal(bytes.length, entries[0]!.sizeBytes);
  return bytes;
}

/** No app, Host or native invocation. Writes only a new external evidence file after all reads pass. */
export async function reconcileNativeReviewContinuation(options: {
  root: string;
  originalArtifact: string;
  continuationArtifact: string;
  output: string;
}): Promise<Row> {
  const { root, originalArtifact, continuationArtifact, output } = options;
  for (const path of Object.values(options)) assert.ok(isAbsolute(path) && resolve(path) === path);
  for (const protectedRoot of [root, originalArtifact, continuationArtifact]) {
    const suffix = relative(protectedRoot, output);
    assert.ok(suffix.startsWith('../'), 'output must be outside every retained tree');
  }
  const before = await inventory(root);
  const nativeBytes = await retained(originalArtifact, 'receipt.json'),
    continuationBytes = await retained(continuationArtifact, 'receipt.json');
  assert.equal(
    sha(nativeBytes),
    'f89d101d9533b764e24d2c5a5d9a7e91dbb8ea2bc16a11427f730f14184c8360'
  );
  assert.equal(
    sha(continuationBytes),
    '08ed901d5d4a1fe32b4444593673467e2f19a5fce08808db050f5845ed3262ef'
  );
  assert.deepEqual(await readFile(join(root, 'desktop-backend-receipt.json')), nativeBytes);
  assert.deepEqual(
    await readFile(join(root, 'desktop-native-review-continuation-receipt.json')),
    continuationBytes
  );
  const native = record(JSON.parse(nativeBytes.toString('utf8'))),
    continuation = record(JSON.parse(continuationBytes.toString('utf8')));
  assert.equal(continuation.status, 'INCOMPLETE');
  assert.equal(continuation.mode, 'native-review-continuation-ui');
  const proof = record(continuation.nativeReviewContinuationProof);
  assert.equal(proof.status, 'INCOMPLETE');
  assert.equal(proof.originalReceiptSha256, sha(nativeBytes));
  const failure = String(continuation.failure);
  assert.ok(failure.startsWith('Expected values to be strictly deep-equal:'));
  const frozenSource = await retained(
    continuationArtifact,
    'executed-source/scripts/legacy-agent-host/desktop-native-review-continuation.ts'
  );
  assert.equal(sha(frozenSource), proof.sourceSha256);
  assert.ok(
    frozenSource
      .toString('utf8')
      .includes('assert.deepEqual(await readDesktopReviewDecisions(options.root), persistence);')
  );
  const source = await readNativeReviewContinuationSource(root, native);
  assert.equal(proof.undoFileSha256, sha(source.seed.after));
  assert.equal(source.fileSha256, sha(source.seed.mixed));
  const steps = (proof.steps as unknown[]).map(record);
  for (const label of [
    'Undo original retained native hunk rejection once',
    'Redo original retained native hunk rejection once',
    'open continued original History',
  ])
    assert.equal(
      steps.filter((row) => row.action === 'mouseClick' && row.label === label).length,
      1
    );
  assert.equal(
    steps.filter((row) => row.label === 'close and flush continued original Changes').length,
    2
  );
  const observed = source.persistence[0]!;
  assert.equal(observed.sha256, /\+\s+sha256: '([a-f0-9]{64})'/.exec(failure)?.[1]);
  const expected = reconstructNativeReviewExpectedSnapshot(failure, observed, source.seed.filePath);
  const persistence = assertNativeReviewPersistence([expected], source.persistence, source.seed);
  const retainedState = async (path: string) => {
    const actual = await readFile(join(root, path));
    assert.deepEqual(actual, await retained(originalArtifact, 'state/' + path));
    assert.deepEqual(actual, await retained(continuationArtifact, 'state/' + path));
  };
  await retainedState(relative(root, source.statePath));
  await retainedState(relative(root, source.eventPath));
  const runtimeInventory = before.filter(
    (row) =>
      String(row.path).startsWith('hoststore/runtime-sessions/') &&
      String(row.path).endsWith('.json')
  );
  assert.equal(runtimeInventory.length, 2);
  const runtimeActivityChanges: Row[] = [];
  for (const row of runtimeInventory) {
    const path = String(row.path),
      actualBytes = await readFile(join(root, path));
    assert.deepEqual(actualBytes, await retained(continuationArtifact, 'state/' + path));
    const oldRuntime = record(
      JSON.parse((await retained(originalArtifact, 'state/' + path)).toString('utf8'))
    );
    const currentRuntime = record(JSON.parse(actualBytes.toString('utf8')));
    const { activitySequence: oldSequence, ...oldFields } = oldRuntime;
    const { activitySequence: newSequence, ...newFields } = currentRuntime;
    assert.deepEqual(
      newFields,
      oldFields,
      'every Runtime field except observed activity high-water remains exact'
    );
    assert.equal(newSequence, Number(oldSequence) + 2);
    const activityPath = 'hoststore/runtime-events/' + path.split('/').at(-1);
    const oldActivity = record(
      JSON.parse((await retained(originalArtifact, 'state/' + activityPath)).toString('utf8'))
    );
    const activityBytes = await readFile(join(root, activityPath));
    assert.deepEqual(activityBytes, await retained(continuationArtifact, 'state/' + activityPath));
    const activity = record(JSON.parse(activityBytes.toString('utf8')));
    assert.equal(oldActivity.sequence, oldSequence);
    assert.equal(activity.sequence, newSequence);
    assert.deepEqual(activity.binding, currentRuntime.binding);
    const oldEvents = (oldActivity.events as unknown[]).map(record),
      events = (activity.events as unknown[]).map(record);
    assert.deepEqual(events.slice(0, oldEvents.length), oldEvents);
    const added = events.slice(oldEvents.length);
    assert.equal(added.length, 2);
    for (const event of added) {
      assert.deepEqual(
        event.data,
        oldEvents.at(-1)!.data,
        'only repeated original closed/released state observations'
      );
      const data = record(event.data),
        state = record(data.state);
      assert.equal(data.kind, 'state');
      assert.equal(state.phase, 'closed');
      assert.equal(state.custody, 'released');
      assert.equal(state.queuedInputs, 0);
      assert.equal(state.activeInputs, 0);
    }
    runtimeActivityChanges.push({
      path,
      before: oldSequence,
      after: newSequence,
      addedEvents: added,
    });
  }
  assert.equal(await fileDigest(join(root, 'workspace/.git/index')), source.seed.gitIndexSha256);
  await retainedState('workspace/pre-existing-untracked.txt');
  const table = processTable(),
    physical: Row[] = [];
  for (const [name, raw] of [
    ['native', native],
    ['continuation', continuation],
  ] as const) {
    const cleanup = record(raw.cleanup);
    assert.deepEqual(cleanup.remaining, []);
    assert.equal(cleanup.capturedHostObserved, true);
    assert.equal(cleanup.capturedHostAbsent, true);
    const group = Number(cleanup.processGroup);
    assert.ok(Number.isSafeInteger(group) && group > 1);
    assert.deepEqual(
      table.filter((row) => row.pgid === group),
      []
    );
    physical.push({ epoch: name, group, recordedHostAbsent: true, groupAbsentNow: true });
  }
  const nativeChildren = (record(source.original.stop).children as unknown[]).map(record);
  for (const child of nativeChildren)
    assert.equal(
      table.some((row) => row.pid === child.pid),
      false
    );
  const after = await inventory(root);
  assert.deepEqual(
    after,
    before,
    'reconciliation leaves all retained-root bytes and symlink targets unchanged'
  );
  const report: Row = {
    status: 'READ_ONLY_RECONCILED',
    scope:
      'Remaining assertions of the failed continuation; no replay, app, Host or native allocation',
    originalNativeStatus: native.status,
    originalContinuationStatus: continuation.status,
    receipts: {
      nativeSha256: sha(nativeBytes),
      continuationSha256: sha(continuationBytes),
      unchanged: true,
    },
    sourceEpochs: proof.sourceEpochs,
    reconciliationSourceSha256: await fileDigest(import.meta.filename),
    expectedPreReloadSnapshot: {
      provenance: 'RECONSTRUCTED from printed diff; not separately retained original bytes',
      sha256: expected.sha256,
      rawAssertionDiffSha256: sha(failure),
    },
    persistenceComparison: persistence,
    decisionsAndHistoryRetained: true,
    originalRuntimeInputsUnchanged: true,
    runtimeRecordsByteIdenticalToOriginal: false,
    runtimeActivityChanges,
    teamStateUnchanged: true,
    nativeEventsUnchanged: true,
    originalIndexUnchanged: true,
    unrelatedFileUnchanged: true,
    physical,
    nativeChildrenAbsentNow: nativeChildren.map((row) => row.pid),
    fileSha256: source.fileSha256,
    retainedRootInventorySha256: sha(JSON.stringify(after)),
    retainedRootEntries: after.length,
    rootBytesUnchangedDuringReconciliation: true,
    limits: [
      'Both raw runs remain INCOMPLETE; this is a read-only composite reconciliation.',
      'Historical Undo/Redo/reload assertions follow the frozen executed helper and its failure checkpoint; no UI action was rerun.',
      'No vendor inference qualification, full M13/M16/Stage1, release or merge claim.',
    ],
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [root, originalArtifact, continuationArtifact, output] = process.argv.slice(2);
  assert.ok(root && originalArtifact && continuationArtifact && output);
  const report = await reconcileNativeReviewContinuation({
    root,
    originalArtifact,
    continuationArtifact,
    output,
  });
  console.log(JSON.stringify({ status: report.status, output, sha256: await fileDigest(output) }));
}
