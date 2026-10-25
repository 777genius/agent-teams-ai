import assert from 'node:assert/strict';
import { verifyNativeProcessReadbackSource } from './desktop-native-process-readback.ts';
import { verifyDesktopNativeQuitReadbackSource } from './desktop-native-quit-ui-smoke.ts';
import { readNativeReviewRuntimeRecords } from './desktop-native-review-runtime.ts';
import {
  nativeReviewContinuationStage,
  readNativeReviewContinuationSource,
} from './desktop-native-review-continuation-source.ts';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { desktopBackendEnvironment, fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
/** TEST artifact disambiguation only; never changes the retained owner/profile or admission. */
export function desktopReadbackArtifactName(
  name: string,
  attemptId = process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID
): string {
  assert.match(name, /^[a-z0-9][a-z0-9.-]*\.(?:json|log|png)$/);
  if (attemptId === undefined) return name;
  assert.match(attemptId, /^[A-Za-z0-9]{6}$/);
  return name.replace(/\.(json|log|png)$/, `-${attemptId}.$1`);
}
/** Artifact-only selection. Native continuation never becomes the ordinary runtime readback mode. */
export function desktopReadbackArtifacts(
  mode: {
    readbackMode: boolean;
    nativeReviewContinuationMode: boolean;
    nativeReviewReadbackMode: boolean;
    reviewReadbackMode: boolean;
  },
  stage = process.env.LEGACY_DESKTOP_REVIEW_CONTINUATION_STAGE,
  attemptId = process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID
): { receipt: string; appLog: string; failureScreenshot: string } {
  const suffixAllowed = mode.readbackMode || mode.nativeReviewContinuationMode;
  if (attemptId !== undefined)
    assert.ok(
      suffixAllowed,
      'attempt suffix requires explicit ordinary readback or native review continuation'
    );
  if (mode.nativeReviewContinuationMode)
    assert.ok(stage === undefined || ['undo', 'pre-review', 'history'].includes(stage));
  const prefix = mode.nativeReviewContinuationMode
    ? stage === 'history'
      ? 'desktop-native-review-history'
      : stage === 'pre-review'
        ? 'desktop-native-review-pre-review'
        : 'desktop-native-review-continuation'
    : mode.nativeReviewReadbackMode
      ? 'desktop-native-review-readback'
      : mode.reviewReadbackMode
        ? 'desktop-review-readback'
        : mode.readbackMode
          ? 'desktop-readback'
          : 'desktop-backend';
  return {
    receipt: desktopReadbackArtifactName(prefix + '-receipt.json', attemptId),
    appLog: desktopReadbackArtifactName(
      prefix === 'desktop-backend' ? 'desktop-app.log' : prefix + '-app.log',
      attemptId
    ),
    failureScreenshot: desktopReadbackArtifactName(
      suffixAllowed ? 'ui-readback-failure.png' : 'ui-failure.png',
      attemptId
    ),
  };
}
/** Reopen only an exact retained TEST fixture; never recreate or replay its business commands. */
export async function readSavedDesktopFixture(
  root: string,
  receiptSha256: string,
  options: { nativeQuit?: boolean; review?: boolean; nativeReview?: boolean; nativeReviewContinuation?: boolean; nativeProcess?: boolean } = {}
): Promise<Fixture> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const receipt = join(root, 'desktop-backend-receipt.json');
  assert.match(receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(await fileDigest(receipt), receiptSha256);
  const saved = record(JSON.parse(await readFile(receipt, 'utf8')));
  assert.equal(saved.root, root);
  const paths = record(saved.paths);
  const pins = record(saved.pins) as Fixture['pins'];
  const node = String(paths.node),
    hostEntry = String(paths.hostEntry);
  const descriptorPath = String(paths.descriptor),
    profilePath = String(paths.profile);
  assert.equal(descriptorPath, join(root, 'desktop-descriptor.json'));
  assert.equal(profilePath, join(root, 'host-profile.json'));
  for (const [path, expected] of [
    [node, pins.nodeSha256],
    [hostEntry, pins.hostEntrySha256],
    [descriptorPath, pins.descriptorSha256],
    [profilePath, pins.profileSha256],
    [join(root, 'bin/claude'), pins.sentinelSha256],
    [join(root, 'bin/pnpm'), pins.pnpmStubSha256],
  ] as const) {
    assert.equal(await realpath(path), path);
    assert.equal(await fileDigest(path), expected);
  }
  const manager = saved.packageManager as Fixture['packageManager'];
  assert.equal(await fileDigest(manager.packagePath), pins.corepackPackageSha256);
  assert.equal(await fileDigest(manager.libraryPath), pins.corepackLibrarySha256);
  const descriptor = record(JSON.parse(await readFile(descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.handles) && descriptor.handles.length === 1);
  const handleId = String(record(descriptor.handles[0]).handleId);
  const seed = record(JSON.parse(await readFile(join(root, 'ui-seed-receipt.json'), 'utf8')));
  const taskId = String(record(seed.effects).taskId);
  const subject = options.nativeProcess ? 'TEST native process cold-owner sidebar seed' : 'TEST persisted Host sidebar seed';
  const tasks = await readdir(join(root, 'hoststore/tasks/test-desktop-backend'));
  assert.ok(tasks.includes(taskId + '.json'));
  if (options.nativeProcess) {
    await verifyNativeProcessReadbackSource(root, saved);
    const task = record(JSON.parse(await readFile(join(root, 'hoststore/tasks/test-desktop-backend', taskId + '.json'), 'utf8')));
    assert.equal(task.subject, subject);
  } else if (options.nativeQuit) {
    await verifyDesktopNativeQuitReadbackSource(root, saved);
  } else if (options.nativeReviewContinuation) {
    await readNativeReviewContinuationSource(root, saved, nativeReviewContinuationStage());
  } else if (options.nativeReview) {
    assert.equal(saved.mode, 'native-review-ui');
    assert.equal(saved.status, 'PASS');
    const proof = record(saved.nativeReviewUiProof);
    assert.equal(proof.status, 'PASS');
    assert.equal(await fileDigest(join(root, 'native-review-ui-seed.json')), proof.seedSha256);
    await readNativeReviewRuntimeRecords(root, proof);
    assert.ok(typeof proof.taskId === 'string' && /^[A-Za-z0-9_-]+$/.test(proof.taskId));
    assert.ok(tasks.includes(proof.taskId + '.json'));
  } else if (options.review) {
    assert.equal(saved.mode, 'review-ui');
    assert.equal(saved.status, 'PASS');
    assert.equal(record(saved.reviewUiProof).status, 'PASS');
    assert.equal(
      await fileDigest(join(root, 'review-ui-seed.json')),
      record(saved.reviewUiProof).seedSha256
    );
  } else {
    const sessions = await readDesktopNativeStopSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.phase, 'closed');
    assert.equal(sessions[0]!.custody, 'released');
  }
  return {
    root,
    node,
    hostEntry,
    descriptorPath,
    profilePath,
    handleId,
    pins,
    sentinelLog: join(root, 'sentinel-invocations.ndjson'),
    uiSeed: { taskId, subject, commandId: options.nativeProcess ? 'TEST-process-ui-seed' : 'TEST-ui-offline-seed' },
    packageManager: saved.packageManager as Fixture['packageManager'],
    appEnvironment: desktopBackendEnvironment(root, node, descriptorPath, pins.descriptorSha256),
  };
}
export async function runDesktopNativeReadback(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { taskId: string; subject: string };
    assertOwnedRenderer(): void;
    assertNoNativeChildren(): void;
    evidence: Record<string, unknown>;
  }
) {
  const steps: Record<string, unknown>[] = [];
  options.evidence.savedNativeReadback = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Ordinary UI readback of original saved native effect, no launch/restore/message/tool command',
  };
  const before = await readDesktopNativeStopSessions(options.root);
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => {
      steps.push(value);
    },
  });
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  if (
    !(await cdp.evaluate(
      `Boolean(document.querySelector('.message-composer-flat-layout textarea'))`
    ))
  )
    await ui.click('button[aria-label^="alice,"]', 'open saved ordinary direct chat');
  await ui.waitRead(
    `document.body.innerText.includes('REPLY_NATIVE_ONE')`,
    'saved native reply rendered'
  );
  const geometry = await revealDesktopReply(cdp, 'REPLY_NATIVE_ONE', {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => {
      steps.push(value);
    },
  });
  options.assertNoNativeChildren();
  await ui.waitRead(
    `document.querySelectorAll('.kanban-task-card[data-task-id]').length===2`,
    'saved seed plus native Task in ordinary Kanban'
  );
  const image = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const { writeFile } = await import('node:fs/promises');
  const path = join(options.root, 'ui-native-readback.png');
  await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600 });
  const after = await readDesktopNativeStopSessions(options.root);
  assert.deepEqual(
    after,
    before,
    'UI readback never opens/restores or submits to the original Native session'
  );
  options.assertNoNativeChildren();
  options.evidence.savedNativeReadback = {
    ...record(options.evidence.savedNativeReadback),
    status: 'PASS',
    geometry,
    nativeInputsReplayed: 0,
    nativeAllocations: 0,
    runtimeRecordUnchanged: true,
    screenshot: { path, sha256: await fileDigest(path) },
  };
}
