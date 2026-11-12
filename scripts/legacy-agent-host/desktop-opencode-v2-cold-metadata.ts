import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';
import { processTable } from './desktop-backend-observations.ts';
import { assertNativeReviewRuntimeRecords } from './desktop-native-review-runtime.ts';
import {
  readDesktopNativeHostProcesses,
  readDesktopNativeStopSessions,
  separateDesktopOpenCodeRuntimeChildren,
} from './desktop-native-stop-fixture.ts';
import { checkpoint } from './desktop-resume-records.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};

/** Absence-only witness for the original detached child, before any fallback cleanup. */
export function assertCapturedColdMetadataAbsent(
  evidence: Row,
  observed?: ReturnType<typeof processTable>
): void {
  if (evidence.coldOpenCodeMetadata === undefined) return;
  const proof = row(evidence.coldOpenCodeMetadata),
    captured = row(proof.captured);
  assert.equal(proof.metadataProcessCount, 1);
  assert.ok(Array.isArray(captured.children) && captured.children.length === 1);
  const child = row(captured.children[0]);
  assert.ok(Number.isSafeInteger(child.pid) && Number(child.pid) > 1);
  assert.equal(child.parentPid, row(captured.host).pid);
  assert.ok(typeof child.birth === 'string' && child.birth.length > 0);
  assert.equal(
    (observed ?? processTable()).some((current) => current.pid === child.pid),
    false,
    'the original captured metadata child is absent after guarded Quit, before harness cleanup'
  );
  proof.metadataAbsentBeforeHarnessCleanup = true;
}

/** A cold read can preserve pending-open uncertainty; it cannot adopt or clear it. */
export function assertColdOpenCodeRuntimeRecords(source: Row, profile: Row, sessions: Row[]): void {
  if (source.mode === 'native-review-ui') {
    const original = row(source.nativeReviewUiProof);
    assert.equal(original.provider, 'opencode-v2');
    assertNativeReviewRuntimeRecords(sessions, original, profile);
    return;
  }
  assert.equal(sessions.length, 1, 'only the original captured Runtime record');
  const session = sessions[0]!;
  if (source.mode === 'native-quit-ui') {
    const original = row(source.nativeQuitUiProof),
      after = row(original.afterQuit);
    assert.equal(original.status, 'PASS');
    assert.deepEqual(session, after.session);
    assert.equal(session.sealed, true);
    assert.equal(session.nativeReady, false);
    if (after.runtimeOutcome === 'held-unknown') {
      assert.equal(original.scenario, 'pending-open');
      assert.equal(after.debtRetained, true);
      assert.equal(after.originalGroupAbsentBeforeHarnessCleanup, true);
      assert.equal(after.nativeChildrenAbsent, true);
      assert.equal(session.phase, 'held');
      assert.equal(session.custody, 'unknown');
      assert.equal(session.diagnostic, 'open-unknown');
      assert.deepEqual(session.inputs, []);
      assert.deepEqual(session.interactions, []);
      return;
    }
    assert.equal(after.runtimeOutcome, 'closed-released');
  } else {
    assert.equal(source.mode, 'native-conversation-ui');
    const original = row(source.conversationUiProof);
    assert.equal(original.status, 'PASS');
    assert.equal(original.custody, 'released');
    assert.equal(original.nativeChildAbsentBeforeQuit, true);
    assert.equal(original.nativeInputs, 2);
    assert.ok(Array.isArray(session.inputs) && session.inputs.length === 2);
    assert.ok(
      session.inputs
        .map(row)
        .every((input) => input.phase === 'terminal' && input.terminal === 'succeeded')
    );
  }
  assert.equal(session.phase, 'closed');
  assert.equal(session.custody, 'released');
}

/** Observe the original metadata child; never create, adopt or resume a Runtime session. */
export async function captureDesktopOpenCodeV2ColdMetadata(
  cdp: UiCdpPort,
  options: {
    root: string;
    node: string;
    hostEntry: string;
    group: number;
    evidence: Row;
    assertOwnedRenderer(): void;
  }
): Promise<
  undefined | { metadataProcessCount: 1; hostPid: number; assertNoRuntimeChildren(): Promise<void> }
> {
  const sourcePath = join(options.root, 'desktop-backend-receipt.json');
  const source = row(JSON.parse(await readFile(sourcePath, 'utf8')));
  if (source.nativeGeneration !== 'v2') return undefined;
  assert.equal(source.nativeProvider, 'opencode');
  assert.equal(source.status, 'PASS');
  assert.equal(source.root, options.root);
  const sourceSha256 = await fileDigest(sourcePath),
    profilePath = join(options.root, 'host-profile.json');
  const profileSha256 = await fileDigest(profilePath);
  assert.equal(profileSha256, row(source.pins).profileSha256);
  const profile = row(JSON.parse(await readFile(profilePath, 'utf8')));
  const members = row(profile.runtime).members;
  assert.ok(Array.isArray(members) && members.length === 1);
  assert.ok(Array.isArray(profile.management) && profile.management.length === 1);
  const member = row(members[0]),
    management = row(profile.management[0]);
  for (const selected of [member, management]) {
    assert.equal(selected.provider, 'opencode');
    assert.equal(selected.nativeGeneration, 'v2');
    assert.equal(selected.protocolRevision, '2.1.4');
  }
  assert.deepEqual(management.executable, member.executable);
  for (const field of ['directory', 'manifestSha256', 'version', 'platform', 'arch'])
    assert.equal(row(management.embedded)[field], row(member.embedded)[field]);
  const executable = row(management.executable),
    model = row(management.nativeModel);
  assert.equal(model.providerId, row(member.nativeOptions).providerId);
  assert.equal(model.modelId, member.model);
  assert.ok(typeof model.providerId === 'string' && typeof model.modelId === 'string');
  assert.ok(typeof executable.path === 'string' && typeof executable.sha256 === 'string');
  const executablePath = executable.path,
    executableSha256 = executable.sha256;
  assert.match(executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(await realpath(executablePath), executablePath);
  assert.equal(await fileDigest(executablePath), executableSha256);
  const sessions = await readDesktopNativeStopSessions(options.root);
  assertColdOpenCodeRuntimeRecords(source, profile, sessions);
  if (source.mode === 'native-conversation-ui') {
    const history = await checkpoint(options.root, sessions[0]!, 'opencode');
    const attachments = row(source.nativeChatAttachments);
    assert.equal(attachments.status, 'PASS');
    assert.deepEqual(
      {
        nativeSessionId: history.nativeSession,
        sha256: history.historySha256,
        byteLength: history.history.length,
      },
      attachments.nativeHistory
    );
  }
  const before = readDesktopNativeHostProcesses(options, options.group);
  assert.ok(before.children.length <= 1, 'no extra child before the explicit metadata read');
  options.assertOwnedRenderer();
  const response = row(
    await cdp.evaluate(
      `window.electronAPI.runtimeProviderManagement.loadModels(${desktopJsLiteral({
        runtimeId: 'opencode',
        providerId: model.providerId,
        projectPath: null,
        refresh: true,
      })})`
    )
  );
  options.assertOwnedRenderer();
  assert.equal(response.error, undefined);
  assert.equal(response.runtimeId, 'opencode');
  const catalog = row(response.models);
  assert.equal(catalog.providerId, model.providerId);
  assert.equal(catalog.catalogState, 'fresh');
  assert.ok(Array.isArray(catalog.models));
  const declared = catalog.models
    .map(row)
    .find(
      (value) =>
        value.providerId === model.providerId &&
        value.modelId === `${model.providerId}/${model.modelId}`
    );
  assert.ok(
    declared &&
      Array.isArray(declared.declaredInputModalities) &&
      declared.declaredInputModalities.includes('text')
  );
  const captured = readDesktopNativeHostProcesses(options, options.group);
  assert.deepEqual(captured.host, before.host);
  assert.equal(captured.children.length, 1, 'one original metadata child, no Runtime child');
  assert.equal(captured.children[0]!.command, executablePath);
  if (before.children.length) assert.deepEqual(captured.children, before.children);
  const assertNoRuntimeChildren = async () => {
    options.assertOwnedRenderer();
    assert.equal(await fileDigest(sourcePath), sourceSha256);
    assert.equal(await fileDigest(profilePath), profileSha256);
    assert.equal(await realpath(executablePath), executablePath);
    assert.equal(await fileDigest(executablePath), executableSha256);
    const current = await readDesktopNativeStopSessions(options.root);
    assertColdOpenCodeRuntimeRecords(source, profile, current);
    assert.deepEqual(
      current,
      sessions,
      'metadata/UI reads preserve every original Runtime byte projection'
    );
    separateDesktopOpenCodeRuntimeChildren(
      captured,
      readDesktopNativeHostProcesses(options, options.group),
      0
    );
  };
  await assertNoRuntimeChildren();
  options.evidence.coldOpenCodeMetadata = {
    phase: 'captured-before-ui',
    sourceSha256,
    profileSha256,
    executableSha256,
    providerId: model.providerId,
    modelId: model.modelId,
    metadataProcessCount: 1,
    nativeRuntimeAllocations: 0,
    captured,
  };
  return { metadataProcessCount: 1, hostPid: captured.host.pid, assertNoRuntimeChildren };
}
