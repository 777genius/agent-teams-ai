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
  assertDesktopOpenCodeMetadataSources,
  captureDesktopOpenCodeColdMetadata,
  observeDesktopOpenCodeMetadata,
} from './desktop-native-stop-fixture.ts';
import { checkpoint } from './desktop-resume-records.ts';
import { assertDesktopMetadataLineageReleased, assertDesktopMetadataLineageRetained,
  assertDesktopMetadataReleasedEvidence } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopMetadataLineage, DesktopNativeHostSnapshot } from './desktop-opencode-metadata-lineage.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};

/** Read-only identity binding; a reused or orphaned PID is never absence. */
function assertOriginalMetadataAbsent(
  value: unknown,
  selected: unknown,
  observed: ReturnType<typeof processTable>,
  label: string,
  expectedChildren: 1 | 2 = 2
): Row[] {
  const captured = row(value), host = row(captured.host), selectedHost = row(selected);
  assert.ok(Number.isSafeInteger(host.pid) && Number(host.pid) > 1);
  assert.ok(typeof host.birth === 'string' && host.birth.length > 0);
  assert.equal(host.pid, selectedHost.pid);
  assert.equal(host.parentPid, selectedHost.ppid);
  assert.equal(host.groupId, selectedHost.pgid);
  assert.ok(Array.isArray(captured.children) && captured.children.length === expectedChildren);
  const children = captured.children.map(row);
  assert.equal(new Set(children.map(child => child.pid)).size, expectedChildren);
  for (const child of children) {
    assert.ok(Number.isSafeInteger(child.pid) && Number(child.pid) > 1);
    assert.notEqual(child.pid, host.pid);
    assert.equal(child.parentPid, host.pid);
    assert.ok(typeof child.birth === 'string' && child.birth.length > 0);
    assert.equal(observed.some(current => current.pid === child.pid), false, label);
  }
  return children;
}

function hasHotOpenCodeV2Metadata(evidence: Row): boolean {
  const optional = (key: string): Row => evidence[key] === undefined ? {} : row(evidence[key]);
  const selected = evidence.nativeGeneration === 'v2' ||
    optional('nativeReviewUiProof').provider === 'opencode-v2' ||
    optional('resumeNativeProfile').nativeGeneration === 'v2' ||
    optional('nativeSetup').metadataBeforeLaunch !== undefined ||
    optional('nativeReviewUiProof').originalMetadataBeforeLaunch !== undefined ||
    optional('launchDialogProof').originalMetadataBeforeLaunch !== undefined ||
    optional('resumeDialogProof').originalMetadataBeforeResume !== undefined;
  if (selected) {
    assert.equal(evidence.nativeGeneration, 'v2');
    assert.equal(evidence.nativeProvider, 'opencode');
  }
  return selected;
}


function retainedMetadata(proof: Row): DesktopNativeHostSnapshot {
  const values = ['captured', 'originalMetadataBeforeLaunch', 'originalMetadataBeforeResume', 'metadataBeforeLaunch',
    'metadataAtRuntimeObservation', 'metadataAfterStop', 'metadataAfterSecondStop',
    'metadataAfterRendererReload', 'metadataAfterReadback'].flatMap(key =>
      proof[key] === undefined ? [] : [{ key, value: row(proof[key]) as unknown as DesktopNativeHostSnapshot }]);
  assert.ok(values.length > 0);
  const original = values[0]!.value;
  assert.ok(original.metadataLineage);
  let previous = original;
  for (const { key, value } of values.slice(1)) {
    assert.deepEqual(value.host, original.host);
    assert.ok(value.metadataLineage && previous.metadataLineage);
    assert.deepEqual(value.metadataLineage.profileHashes, original.metadataLineage.profileHashes);
    assertDesktopMetadataLineageRetained(previous.metadataLineage, value.metadataLineage);
    if (key !== 'metadataAtRuntimeObservation') separateDesktopOpenCodeRuntimeChildren(original, value, 0);
    previous = value;
  }
  return previous;
}

function assertMetadataClosed(proof: Row, observed: readonly { pid: number }[]): void {
  const captured = retainedMetadata(proof);
  assert.ok(proof.metadataAtHostClose, 'actual final original-owner close observations are required');
  assertDesktopMetadataReleasedEvidence(captured, row(proof.metadataAtHostClose) as unknown as DesktopMetadataLineage, observed);
}

/** Wait only for the existing private log drain; no RPC, allocation, replay or native signal. */
export async function observeDesktopMetadataClose(root: string, evidence: Row, firstResume = false): Promise<void> {
  const cold = evidence.coldOpenCodeMetadata !== undefined;
  if (!cold && (!['native-review-ui', 'native-stop-ui', 'native-conversation-ui', 'native-quit-ui',
    'native-launch-ui', 'native-resume-ui'].includes(String(evidence.mode)) || !hasHotOpenCodeV2Metadata(evidence))) return;
  const proof = cold ? row(evidence.coldOpenCodeMetadata) :
    firstResume || evidence.mode === 'native-launch-ui' ? row(evidence.launchDialogProof) :
    evidence.mode === 'native-resume-ui' ? row(evidence.resumeDialogProof) :
    evidence.mode === 'native-review-ui' ? row(evidence.nativeReviewUiProof) : row(evidence.nativeSetup);
  const captured = retainedMetadata(proof), deadline = Date.now() + 5000;
  let last: unknown;
  do {
    try {
      proof.metadataAtHostClose = assertDesktopMetadataLineageReleased(root, captured, processTable());
      return;
    } catch (error) { last = error; }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw last;
}

/** The first detached metadata child must be gone before a cold Resume can spawn. */
export function assertFirstResumeMetadataAbsent(
  evidence: Row,
  observed?: ReturnType<typeof processTable>
): void {
  if (!hasHotOpenCodeV2Metadata(evidence)) return;
  assert.equal(evidence.mode, 'native-resume-ui');
  const boundary = row(evidence.coldResumeBoundary), launch = row(evidence.launchDialogProof);
  assert.equal(boundary.provider, 'opencode');
  assert.equal(boundary.secondEpoch, undefined, 'absence is observed before the second app spawn');
  assert.equal(launch.provider, 'opencode');
  assert.equal(launch.status, 'INCOMPLETE', 'the original Launch proof is waiting for cold startup');
  assert.equal(row(launch.stop).releasedBeforeQuit, true);
  retainedMetadata(launch);
  assertDesktopOpenCodeMetadataSources(launch.metadataSources, launch.originalMetadataBeforeLaunch);
  const cleanup = row(boundary.firstCleanup);
  assert.equal(cleanup.appExitCode, 0); assert.equal(cleanup.appSignalCode, null);
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.capturedHostAbsent, true); assert.equal(cleanup.writerLockReleased, true);
  assertOriginalMetadataAbsent(launch.originalMetadataBeforeLaunch, row(boundary.firstEpoch).host,
    observed ?? processTable(), 'the first Resume metadata child is absent before the second app spawn');
  assertMetadataClosed(launch, observed ?? processTable());
  boundary.firstMetadataAbsentBeforeSecondSpawn = true;
}

/** Absence-only witnesses for original detached children, before fallback cleanup. */
export function assertCapturedDesktopMetadataAbsent(
  evidence: Row,
  observed?: ReturnType<typeof processTable>
): void {
  if (['native-review-ui', 'native-stop-ui', 'native-conversation-ui', 'native-quit-ui',
    'native-launch-ui', 'native-resume-ui'].includes(String(evidence.mode)) && hasHotOpenCodeV2Metadata(evidence)) {
    const table = observed ?? processTable();
    if (evidence.mode === 'native-review-ui') {
      const proof = row(evidence.nativeReviewUiProof);
      assertDesktopOpenCodeMetadataSources(proof.metadataSources, proof.originalMetadataBeforeLaunch);
      assert.equal(proof.provider, 'opencode-v2'); assert.equal(proof.status, 'PASS');
      assertOriginalMetadataAbsent(proof.originalMetadataBeforeLaunch, evidence.hostChild,
        table, 'the hot Review metadata child is absent before harness cleanup');
      assert.deepEqual(row(proof.stop).metadata, row(proof.metadataAfterStop).children);
      assertMetadataClosed(proof, table);
      proof.metadataAbsentBeforeHarnessCleanup = true;
    } else if (evidence.mode === 'native-resume-ui') {
      const boundary = row(evidence.coldResumeBoundary), proof = row(evidence.resumeDialogProof);
      assertDesktopOpenCodeMetadataSources(proof.metadataSources, proof.originalMetadataBeforeResume);
      assertDesktopOpenCodeMetadataSources(row(evidence.launchDialogProof).metadataSources,
        row(evidence.launchDialogProof).originalMetadataBeforeLaunch);
      assert.equal(boundary.provider, 'opencode'); assert.equal(boundary.status, 'PASS');
      assert.equal(boundary.firstMetadataAbsentBeforeSecondSpawn, true);
      assert.equal(row(evidence.launchDialogProof).status, 'PASS');
      assert.equal(proof.provider, 'opencode'); assert.equal(proof.status, 'PASS');
      const secondHost = row(row(boundary.secondEpoch).host);
      assert.notEqual(secondHost.pid, row(row(boundary.firstEpoch).host).pid);
      assertOriginalMetadataAbsent(proof.originalMetadataBeforeResume, secondHost, table,
        'the second Resume metadata child is absent before harness cleanup');
      assertOriginalMetadataAbsent(proof.originalMetadataBeforeResume, evidence.hostChild, table,
        'the final selected Host owns the second Resume metadata child');
      assertMetadataClosed(proof, table);
      proof.metadataAbsentBeforeHarnessCleanup = true;
    } else if (evidence.mode === 'native-launch-ui') {
      const proof = row(evidence.launchDialogProof);
      assertDesktopOpenCodeMetadataSources(proof.metadataSources, proof.originalMetadataBeforeLaunch);
      assert.equal(proof.provider, 'opencode'); assert.equal(proof.status, 'PASS');
      assertOriginalMetadataAbsent(proof.originalMetadataBeforeLaunch, evidence.hostChild, table,
        'the Launch metadata child is absent before harness cleanup');
      assertMetadataClosed(proof, table);
      proof.metadataAbsentBeforeHarnessCleanup = true;
    } else {
      const proof = row(evidence.nativeSetup);
      assertDesktopOpenCodeMetadataSources(proof.metadataSources, proof.metadataBeforeLaunch);
      assert.ok(proof.status === 'ready' || proof.status === 'opening');
      assertOriginalMetadataAbsent(proof.metadataBeforeLaunch, evidence.hostChild, table,
        'the original native setup metadata child is absent before harness cleanup');
      assertMetadataClosed(proof, table);
      proof.metadataAbsentBeforeHarnessCleanup = true;
    }
  }
  if (evidence.mixedCreateLaunchProof !== undefined) {
    const mixed = row(evidence.mixedCreateLaunchProof);
    assert.ok(mixed.openCodeGeneration === 'v1' || mixed.openCodeGeneration === 'v2');
    // V1 retains its existing argv observation. V2 captures this original
    // detached metadata child before any mixed Runtime allocation.
    if (mixed.openCodeGeneration === 'v2' || mixed.originalMetadataChildBeforeLaunch !== undefined) {
      assert.equal(mixed.openCodeGeneration, 'v2');
      assert.equal(mixed.status, 'PASS');
      const child = row(mixed.originalMetadataChildBeforeLaunch);
      const physical = row(row(mixed.isolatedMemberRestart).physical);
      const host = row(physical.originalHost);
      assert.deepEqual(physical.currentHost, host);
      assert.deepEqual(physical.managementChild, child);
      assert.deepEqual(mixed.managementChildBeforeStop, child);
      assert.deepEqual(mixed.managementChildAfterStop, child);
      assertOriginalMetadataAbsent({ host, children: [child] }, evidence.hostChild,
        observed ?? processTable(), 'the original mixed metadata child is absent after guarded Quit, before harness cleanup', 1);
      mixed.managementChildAbsentBeforeHarnessCleanup = true;
    }
  }
  if (evidence.coldOpenCodeMetadata === undefined) return;
  const proof = row(evidence.coldOpenCodeMetadata),
    captured = row(proof.captured);
  assert.equal(proof.metadataProcessCount, 1);
  assertOriginalMetadataAbsent(captured, evidence.hostChild, observed ?? processTable(),
    'the original captured metadata child is absent after guarded Quit, before harness cleanup', 1);
  assert.ok(proof.metadataAfterReadback, 'the latest cold metadata lineage is retained');
  assertMetadataClosed(proof, observed ?? processTable());
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
  const { captured, source: metadataSource } = await captureDesktopOpenCodeColdMetadata(options, options.group, before);
  assert.equal(captured.children[0]!.command, executablePath);
  const proof: Row = {
    phase: 'captured-before-ui',
    sourceSha256,
    profileSha256,
    executableSha256,
    providerId: model.providerId,
    modelId: model.modelId,
    metadataProcessCount: 1,
    nativeRuntimeAllocations: 0,
    metadataSource,
    before,
    captured,
    metadataAfterReadback: captured,
  };
  options.evidence.coldOpenCodeMetadata = proof;
  let latest = captured;
  const assertNoRuntimeChildren = async () => {
    options.assertOwnedRenderer();
    assert.equal(await fileDigest(sourcePath), sourceSha256);
    assert.equal(await fileDigest(profilePath), profileSha256);
    assert.equal(await realpath(executablePath), executablePath);
    assert.equal(await fileDigest(executablePath), executableSha256);
    const { captured: currentMetadata } = await observeDesktopOpenCodeMetadata(options, options.group, latest, 0);
    const current = await readDesktopNativeStopSessions(options.root);
    assertColdOpenCodeRuntimeRecords(source, profile, current);
    assert.deepEqual(
      current,
      sessions,
      'metadata/UI reads preserve every original Runtime byte projection'
    );
    separateDesktopOpenCodeRuntimeChildren(captured, currentMetadata, 0);
    latest = currentMetadata;
    proof.metadataAfterReadback = currentMetadata;
  };
  await assertNoRuntimeChildren();
  return { metadataProcessCount: 1, hostPid: captured.host.pid, assertNoRuntimeChildren };
}
