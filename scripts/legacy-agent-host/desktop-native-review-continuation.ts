import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertNativeReviewPersistence } from './desktop-native-review-continuation-persistence.ts';
import {
  nativeReviewContinuationStage,
  readNativeReviewKeyboardDraftIdentity,
  readNativeReviewContinuationSource,
} from './desktop-native-review-continuation-source.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { desktopReadbackArtifactName } from './desktop-readback-fixture.ts';
import { REVIEW_TASK_SUBJECT } from './desktop-native-review-model.ts';
import {
  createDesktopReviewHunkControls,
  openDesktopReviewHistory,
  readDesktopReviewDecisions,
} from './desktop-review-hunk-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
/** Continue only original review history. No bootstrap, Task creation, model, runtime or ledger writes. */
export async function runDesktopNativeReviewContinuation(
  cdp: UiCdpPort,
  options: {
    root: string;
    evidence: Row;
    assertOwnedRenderer(): void;
    assertNoNativeChildren(): void;
  }
): Promise<void> {
  const receiptPath = join(options.root, 'desktop-backend-receipt.json');
  const originalReceiptBytes = await readFile(receiptPath),
    originalReceiptSha256 = await fileDigest(receiptPath);
  assert.equal(originalReceiptSha256, process.env.LEGACY_DESKTOP_READBACK_RECEIPT_SHA256);
  const raw = record(JSON.parse(originalReceiptBytes.toString('utf8')));
  const source = await readNativeReviewContinuationSource(
      options.root,
      raw,
      nativeReviewContinuationStage()
    ),
    steps: Row[] = [];
  if (source.stage === 'history') {
    const originalCdp = cdp;
    cdp = {
      evaluate: (expression) => originalCdp.evaluate(expression),
      send: (method, params) => {
        assert.notEqual(
          method,
          'Input.dispatchKeyEvent',
          'History-only continuation forbids keyboard dispatch'
        );
        return originalCdp.send(method, params);
      },
    };
  }
  const preserved =
    source.stage === 'history'
      ? await Promise.all(
          [
            'desktop-app.log',
            'desktop-native-review-continuation-receipt.json',
            'desktop-native-review-continuation-app.log',
            'desktop-native-review-pre-review-receipt.json',
            'desktop-native-review-pre-review-app.log',
            'desktop-native-review-history-receipt.json',
            'desktop-native-review-history-app.log',
          ].map(async (name) => ({
            path: join(options.root, name),
            bytes: await readFile(join(options.root, name)),
            sha256: await fileDigest(join(options.root, name)),
          }))
        )
      : [];
  const proof: Row = {
    status: 'INCOMPLETE',
    steps,
    taskId: source.taskId,
    originalReceiptSha256,
    stage: source.stage,
    readbackAttemptId: process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID,
    scope:
      source.stage === 'history'
        ? 'Read-only History/reload continuation after original four review actions; no review action or native input replay'
        : source.stage === 'undo'
          ? 'Continuation of exact retained pre-Undo failure: original Undo/Redo/history/reload only; no replay of native inputs or tools'
          : 'Continuation of exact retained pre-review navigation failure: original Keep/Reject/Undo/Redo/history/reload only; no native replay',
    compositeEvidence:
      source.stage === 'history'
        ? 'Three source epochs: original native capture, completed four review actions, read-only History/reload; all failed receipts remain INCOMPLETE'
        : 'Two source epochs: original native capture/initial review failure plus this continuation; original failure remains INCOMPLETE',
    sourceEpochs: [
      {
        kind: 'original-native-and-initial-review',
        receiptSha256: originalReceiptSha256,
        selectedSourcesDigest: digest(raw.selectedSourceHashesBeforeApp),
        hostEntrySha256: record(raw.pins).hostEntrySha256,
      },
      ...(source.historyCheckpoint
        ? [{ kind: 'original-four-review-actions', ...source.historyCheckpoint }]
        : []),
      {
        kind: 'review-continuation',
        selectedSourcesDigest: digest(options.evidence.selectedSourceHashesBeforeApp),
        hostEntrySha256: record(options.evidence.pins).hostEntrySha256,
      },
    ],
    sourceSha256: await fileDigest(import.meta.filename),
    fileBeforeSha256: source.fileSha256,
    persistenceBefore: source.persistence,
    initialMetadataCommand: source.initialMetadataCommand,
    historyCheckpoint: source.historyCheckpoint,
    priorKeyboardDraftContamination: source.keyboardDraft
      ? {
          description:
            'Prior Tab fallback inserted 59 two-space indents into the saved editor draft only. Exact draft preserved; never applied to disk.',
          ...source.keyboardDraft,
        }
      : undefined,
  };
  options.evidence.nativeReviewContinuationProof = proof;
  const review = createDesktopReviewHunkControls(cdp, {
    taskId: source.taskId,
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
  if (source.stage === 'pre-review') {
    assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.after);
    assert.deepEqual(await readFile(source.statePath), source.stateBytes);
    assert.deepEqual(await readFile(source.eventPath), source.eventBytes);
    assert.deepEqual(await readDesktopNativeStopSessions(options.root), source.sessions);
    await review.hoverLine('const first = 2;');
    await review.ui.click(
      '[data-review-floating-toolbar="true"] button[title^="Accept change"]',
      'Keep first retained native hunk once'
    );
    await review.waitHistory(1, 0);
    assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.after);
    await review.hoverLine('const last = 2;');
    await review.ui.click(
      '[data-review-floating-toolbar="true"] button[title^="Reject change"]',
      'Reject second retained native hunk once'
    );
    await review.waitHistory(2, 0);
    assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.mixed);
  }
  await review.waitHistory(2, 0);
  if (source.stage !== 'history') {
    await review.ui.click('button', 'Undo original retained native hunk rejection once', 'Undo');
    await review.waitHistory(1, 1);
    assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.after);
    proof.undoFileSha256 = await fileDigest(source.seed.filePath);
    await review.ui.click('button', 'Redo original retained native hunk rejection once', 'Redo');
    await review.waitHistory(2, 0);
    assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.mixed);
  }
  await openDesktopReviewHistory(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => {
      steps.push(value);
    },
  });
  const image = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const screenshot = join(
    options.root,
    desktopReadbackArtifactName(
      source.stage === 'history'
        ? 'ui-native-review-history-continuation.png'
        : 'ui-native-review-continuation-history.png'
    )
  );
  await writeFile(screenshot, Buffer.from(String(image.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  await review.ui.click(
    'button[aria-label="Close review history"]',
    'close continued original History'
  );
  const close = async () => {
    await review.ui.click(
      'button[aria-label="Close Changes"]',
      'close and flush continued original Changes'
    );
    await review.ui.waitRead(
      `!document.querySelector('button[aria-label="Close Changes"]')`,
      'continued original Changes closed'
    );
  };
  await close();
  const persistence = await readDesktopReviewDecisions(options.root);
  const authoritativeDecisions = async (snapshots: Row[]): Promise<Row[]> => {
    if (!source.keyboardDraft) return snapshots;
    assert.equal(snapshots.length, 2);
    const draft = snapshots.find((row) => row.path === source.keyboardDraft!.snapshot.path);
    assert.deepEqual(
      draft,
      source.keyboardDraft.snapshot,
      'exact contaminated draft stays byte-identical'
    );
    assert.deepEqual(
      await readNativeReviewKeyboardDraftIdentity(String(draft!.path)),
      source.keyboardDraft.identity
    );
    return snapshots.filter((row) => row !== draft);
  };
  await authoritativeDecisions(persistence);
  proof.persistenceBeforeRendererReload = persistence;
  const origin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await review.ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'continued review renderer reload'
  );
  await review.ui.observeInput();
  await review.openChanges();
  await review.waitHistory(2, 0);
  assert.equal(await readFile(source.seed.filePath, 'utf8'), source.seed.mixed);
  await close();
  const reloadedPersistence = await readDesktopReviewDecisions(options.root);
  proof.persistenceAfterRendererReload = reloadedPersistence;
  proof.persistenceComparison = assertNativeReviewPersistence(
    await authoritativeDecisions(persistence),
    await authoritativeDecisions(reloadedPersistence),
    source.seed
  );
  assert.deepEqual(await readDesktopNativeStopSessions(options.root), source.sessions);
  assert.deepEqual(await readFile(source.statePath), source.stateBytes);
  assert.deepEqual(await readFile(source.eventPath), source.eventBytes);
  assert.deepEqual(
    await readFile(receiptPath),
    originalReceiptBytes,
    'original INCOMPLETE receipt remains byte-identical'
  );
  for (const entry of preserved)
    assert.deepEqual(
      await readFile(entry.path),
      entry.bytes,
      'prior failed continuation receipt/log remains byte-identical'
    );
  assert.equal(
    await fileDigest(join(options.root, 'workspace/.git/index')),
    source.seed.gitIndexSha256
  );
  assert.equal(
    await readFile(join(options.root, 'workspace/pre-existing-untracked.txt'), 'utf8'),
    'TEST unrelated dirty file\n'
  );
  options.assertNoNativeChildren();
  Object.assign(proof, {
    status: 'PASS',
    originalFailurePreserved: true,
    originalNativeInputsUnchanged: true,
    nativeAllocations: 0,
    nativeInputsReplayed: 0,
    reviewActionsReplayed: source.stage === 'history' ? 0 : undefined,
    keyboardDispatchForbidden: source.stage === 'history' ? true : undefined,
    priorKeyboardDraftPreserved: source.keyboardDraft ? true : undefined,
    priorKeyboardDraftIdentityAfter: source.keyboardDraft
      ? await readNativeReviewKeyboardDraftIdentity(String(source.keyboardDraft.snapshot.path))
      : undefined,
    preservedFailedArtifacts: preserved.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    })),
    nativeEventsUnchanged: true,
    teamStateUnchanged: true,
    persistenceAfter: reloadedPersistence,
    fileSha256: await fileDigest(source.seed.filePath),
    screenshot: { path: screenshot, sha256: await fileDigest(screenshot) },
  });
}
