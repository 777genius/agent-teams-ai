import assert from 'node:assert/strict';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { assertNativeReviewPersistence } from './desktop-native-review-continuation-persistence.ts';
import { readNativeReviewRuntimeRecords } from './desktop-native-review-runtime.ts';
import { readNativeReviewSeed } from './desktop-native-review-fixture.ts';
import { REVIEW_TASK_SUBJECT } from './desktop-native-review-model.ts';
import {
  createDesktopReviewHunkControls,
  readDesktopReviewDecisions,
} from './desktop-review-hunk-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Exact retained proof readback only. No model server, launch, restore, input or filesystem setup. */
export async function runDesktopNativeReviewReadback(
  cdp: UiCdpPort,
  options: {
    root: string;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
    assertNoNativeChildren(): void;
  }
): Promise<void> {
  const raw = record(
    JSON.parse(await readFile(join(options.root, 'desktop-backend-receipt.json'), 'utf8'))
  );
  assert.equal(raw.mode, 'native-review-ui');
  assert.equal(raw.status, 'PASS');
  const original = record(raw.nativeReviewUiProof);
  assert.equal(original.status, 'PASS');
  const taskId = String(original.taskId);
  assert.match(taskId, /^[A-Za-z0-9_-]+$/);
  const seed = await readNativeReviewSeed(options.root),
    steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Separate app/Host restart reads original native Task Changes, exact mixed bytes and durable hunk history; no native allocations or inputs',
    originalReceiptSha256: await fileDigest(join(options.root, 'desktop-backend-receipt.json')),
    taskId,
    sourceSha256: await fileDigest(import.meta.filename),
  };
  options.evidence.nativeReviewReadbackProof = proof;
  const sessions = await readNativeReviewRuntimeRecords(options.root, original);
  const team = join(options.root, 'hoststore/teams/test-desktop-backend');
  const eventPath = join(team, '.host-evidence/.board-task-changes/events', taskId + '.jsonl');
  const eventsBefore = await readFile(eventPath);
  assert.deepEqual(
    eventsBefore
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    original.events
  );
  const partialFilePins: { path: string; sha256: string }[] = [];
  const stateBefore = await readFile(join(team, '.host-owner/state.json'));
  const decisionsBefore = await readDesktopReviewDecisions(options.root);
  assertNativeReviewPersistence(
    original.persistence as Record<string, unknown>[],
    decisionsBefore,
    seed
  );
  const review = createDesktopReviewHunkControls(cdp, {
    taskId,
    subject: REVIEW_TASK_SUBJECT,
    fileLabel: 'native-review.ts',
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => {
      steps.push(value);
    },
  });
  await review.ui.observeInput();
  await review.openChanges();
  options.assertNoNativeChildren();
  if (seed.partialCoverage) {
    const partial = seed.partialCoverage, saved = record(original.partialCapture);
    assert.equal(saved.status, 'PARTIAL_OR_GAP'); assert.equal(saved.fullM13, false);
    for (const [path, expected] of [[partial.failedPath, partial.failedAfter],
      [partial.writePath, 'WRITE\nHOOK_LATE\n'], [partial.hookSidePath, partial.hookAfter],
      [partial.backgroundPath, partial.backgroundAfter]] as const) {
      assert.equal(await readFile(path, 'utf8'), expected, 'cold original partial file bytes');
      partialFilePins.push({ path, sha256: await fileDigest(path) });
    }
    assert.equal(await fileDigest(partial.backgroundPath), saved.backgroundFinalSha256);
    const hookFacts = (await readFile(partial.hookLog, 'utf8')).trim().split('\n').map(line => record(JSON.parse(line)));
    assert.deepEqual(hookFacts, saved.hookFacts);
    assert.deepEqual(hookFacts.map(row => [row.phase, row.toolUseId]),
      [['started', 'native_review_work_4'], ['finished', 'native_review_work_4']]);
    partialFilePins.push({ path: partial.hookLog, sha256: await fileDigest(partial.hookLog) });
    const changes = await new TaskChangeLedgerReader().readTaskChanges({ teamName: 'test-desktop-backend', taskId,
      projectDir: join(team, '.host-evidence'), projectPath: join(options.root, 'workspace'), includeDetails: true });
    assert.ok(changes && changes.warnings.length > 0);
    assert.ok(Array.isArray(saved.warnings) && saved.warnings.every(warning =>
      typeof warning === 'string' && changes.warnings.includes(warning)), 'original partial warnings preserved');
    assert.ok(Array.isArray(saved.backgroundRows));
    const events = [saved.failed, saved.write, saved.hook, ...saved.backgroundRows].map(record);
    for (const event of events) {
      const file = changes.files.find(row => row.filePath === event.filePath); assert.ok(file);
      assert.ok(file.snippets.length > 0 && file.snippets.every(snippet => snippet.ledger?.nativeCapture === 'unqualified' &&
        snippet.ledger.originalFullContent === null && snippet.ledger.modifiedFullContent === null &&
        !snippet.oldString && !snippet.newString), 'cold partial capture never becomes writable native content');
    }
    await review.ui.click('button', 'expand saved partial capture warning details', 'Read more');
    const warning = await review.ui.waitRead(`document.body.innerText.includes('Native capture interval is partial')`,
      'cold Changes preserves original partial capture warning');
    proof.partialCapture = { status: 'PARTIAL_OR_GAP', filePins: partialFilePins, hookFacts,
      warnings: changes.warnings, warningVisible: warning, unsafePromotion: false, fullM13: false,
      eventualOutcome: saved.eventualOutcome };
  }
  await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  assert.equal(await fileDigest(seed.filePath), original.fileSha256);
  await review.ui.click(review.historySelector, 'open original saved native review History');
  await review.ui.waitRead(
    `/undo stack/i.test(document.body.innerText)`,
    'saved native review History visible'
  );
  const image = record(
    await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
  );
  const screenshot = join(options.root, 'ui-native-review-host-restarted.png');
  await writeFile(screenshot, Buffer.from(String(image.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  await review.ui.click(
    'button[aria-label="Close review history"]',
    'close saved native review History'
  );
  await review.ui.click(
    'button[aria-label="Close Changes"]',
    'close original saved Changes without mutation'
  );
  await review.ui.waitRead(
    `!document.querySelector('button[aria-label="Close Changes"]')`,
    'saved native Changes closed'
  );
  assert.deepEqual(await readDesktopNativeStopSessions(options.root), sessions);
  assert.deepEqual(await readFile(eventPath), eventsBefore);
  assert.deepEqual(await readFile(join(team, '.host-owner/state.json')), stateBefore);
  assertNativeReviewPersistence(
    decisionsBefore,
    await readDesktopReviewDecisions(options.root),
    seed
  );
  assert.equal(await fileDigest(join(options.root, 'workspace/.git/index')), seed.gitIndexSha256);
  assert.equal(
    await readFile(join(options.root, 'workspace/pre-existing-untracked.txt'), 'utf8'),
    'TEST unrelated dirty file\n'
  );
  for (const pin of partialFilePins) assert.equal(await fileDigest(pin.path), pin.sha256, 'cold readback leaves partial files unchanged');
  options.assertNoNativeChildren();
  Object.assign(proof, {
    status: 'PASS',
    nativeInputsReplayed: 0,
    nativeAllocations: 0,
    runtimeRecordUnchanged: true,
    nativeEventsUnchanged: true,
    reviewDecisionsUnchanged: true,
    fileSha256: await fileDigest(seed.filePath),
    screenshot: { path: screenshot, sha256: await fileDigest(screenshot) },
  });
}
