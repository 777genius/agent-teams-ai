import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CONTEXT_MARKER, REQUIRED_TOOLS, startOpenCodeModel } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { checkpoint, jsonDigest, originalHistoryMarker } from './desktop-resume-records.ts';
import { separateDesktopOpenCodeRuntimeChildren } from './desktop-native-stop-fixture.ts';
import { captureDesktopMetadataLineage, desktopMetadataProfileHash, assertDesktopMetadataReleasedEvidence,
  readDesktopMetadataLineage, readDesktopMetadataLineageFailure } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopNativeHostSnapshot, DesktopMetadataEvent } from './desktop-opencode-metadata-lineage.ts';
import { assertCapturedDesktopMetadataAbsent, assertFirstResumeMetadataAbsent, assertColdOpenCodeRuntimeRecords } from './desktop-opencode-v2-cold-metadata.ts';

const messageId = '11111111-2222-4333-8444-555555555555';
const nativeIdentityHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const metadataSources = (captured: { children: readonly unknown[] }) => [
  { sourceId: 'a'.repeat(64), revision: 'b'.repeat(64), profileId: 'runtime-source:' + 'b'.repeat(64),
    configRevision: 'runtime-source:' + 'b'.repeat(64), scope: 'global', projectPath: null, process: captured.children[0] },
  { sourceId: 'c'.repeat(64), revision: 'd'.repeat(64), profileId: 'runtime-source:' + 'd'.repeat(64),
    configRevision: 'runtime-source:' + 'd'.repeat(64), scope: 'project', projectPath: '/TEST/workspace', process: captured.children[1] },
];
// Constructed oracle inputs only; these do not claim real native/corpus acceptance.
function tracedMetadata(captured: DesktopNativeHostSnapshot): DesktopNativeHostSnapshot {
  const profileHashes = metadataSources(captured).map(desktopMetadataProfileHash);
  const events: DesktopMetadataEvent[] = captured.children.map((child, index) => ({
    hostPid: captured.host.pid, profileHash: profileHashes[index]!, mode: 'provider',
    providerHash: 'e'.repeat(64), pid: child.pid, startIdentityHash: nativeIdentityHash('TEST-birth:' + child.pid), stage: 'ready',
  }));
  return { ...captured, metadataLineage: captureDesktopMetadataLineage({ events, host: captured.host,
    profileHashes, observed: captured.children, executable: '/TEST/bun' }) };
}
function closedMetadata(captured: DesktopNativeHostSnapshot) {
  assert.ok(captured.metadataLineage);
  return { ...captured.metadataLineage, events: [...captured.metadataLineage.events,
    ...captured.metadataLineage.events.map(row => ({ ...row, stage: 'released' as const }))] };
}
const tools = ['shell', ...REQUIRED_TOOLS.map(name => 'agent-teams_' + name)]
  .map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const user = (turn: string) => ({ role: 'user', content: `${JSON.stringify({ messageId, text: turn })}\n` +
  'message_send tool to="user", including commandId and text\nDo not reuse the incoming messageId as a reply commandId' });
async function until(read: () => boolean) {
  const end = Date.now() + 3000;
  while (!read() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(read(), true);
}

test('V2 lifecycle retains the pre-Launch metadata birth identity and refuses replacement or extra children', () => {
  const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host-birth', command: '/TEST/node' };
  const metadata = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' };
  const runtime = { ...metadata, pid: 12, groupId: 12, birth: 'TEST-runtime-birth' };
  const original = { host, children: [metadata] };
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(original, { host, children: [metadata, runtime] }, 1), [runtime]);
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(original, original, 0), []);
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host, children: [{ ...metadata, birth: 'TEST-reused-pid' }, runtime] }, 1));
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host: { ...host, birth: 'TEST-replaced-host' }, children: [metadata, runtime] }, 1));
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host, children: [metadata, runtime, { ...runtime, pid: 13 }] }, 1));
  const project = { ...metadata, pid: 13, groupId: 13, birth: 'TEST-project-metadata' };
  const scoped = tracedMetadata({ host, children: [metadata, project] });
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(scoped, { ...scoped, children: [metadata, runtime, project] }, 1), [runtime]);
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(scoped, { ...scoped, children: [metadata, runtime] }, 1));
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(scoped,
    { ...scoped, children: [metadata, runtime, { ...project, birth: 'TEST-replaced-project' }] }, 1));

  const successor = { ...metadata, pid: 14, groupId: 14, birth: 'TEST-successor-metadata' };
  const initial = scoped.metadataLineage!;
  const released: DesktopMetadataEvent = { ...initial.events[0]!, stage: 'released' };
  const ready: DesktopMetadataEvent = { ...initial.events[0]!, mode: 'directory', providerHash: null,
    pid: successor.pid, startIdentityHash: nativeIdentityHash('TEST-birth:14') };
  const events = [...initial.events, released, ready];
  const observe = (values: readonly DesktopMetadataEvent[], observed = [project, successor, runtime]) =>
    captureDesktopMetadataLineage({ events: values, host, profileHashes: initial.profileHashes,
      observed, executable: '/TEST/bun', original: initial });
  const next = { host, children: [project, successor, runtime], metadataLineage: observe(events) };
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(scoped, next, 1), [runtime]);
  assert.deepEqual(next.metadataLineage.births.find(row => row.pid === metadata.pid), metadata);
  assert.throws(() => observe([...initial.events, ready]), /duplicate live/);
  assert.throws(() => observe([...initial.events, { ...released, stage: 'cleanup-unknown' }, ready]), /unknown cleanup/);
  assert.throws(() => observe([...initial.events, { ...released, startIdentityHash: nativeIdentityHash('TEST-reused-native-birth') }, ready]));
  assert.throws(() => observe(events, [metadata, project, successor, runtime]), /physically absent/);
  assert.throws(() => observe([...initial.events, released, { ...ready, profileHash: 'f'.repeat(64) }]), /captured scope/);
  const closed = { ...next.metadataLineage, events: [...events,
    { ...initial.events[1]!, stage: 'released' as const }, { ...ready, stage: 'released' as const }] };
  assert.doesNotThrow(() => assertDesktopMetadataReleasedEvidence(next, closed, []));
  assert.throws(() => assertDesktopMetadataReleasedEvidence(next, closed, [{ pid: metadata.pid }]), /metadata PID/);
  assert.throws(() => assertDesktopMetadataReleasedEvidence(next, { ...closed, events: closed.events.slice(1) }, []));
});

test('cold metadata reads accept only original completed PNG inputs and no extra Runtime', () => {
  const source = {
    mode: 'native-conversation-ui',
    conversationUiProof: {
      status: 'PASS',
      custody: 'released',
      nativeChildAbsentBeforeQuit: true,
      nativeInputs: 2,
    },
  };
  const session = {
    phase: 'closed',
    custody: 'released',
    inputs: [
      { phase: 'terminal', terminal: 'succeeded' },
      { phase: 'terminal', terminal: 'succeeded' },
    ],
  };
  assert.doesNotThrow(() => assertColdOpenCodeRuntimeRecords(source, {}, [session]));
  for (const changed of [
    { ...session, phase: 'allocated' },
    { ...session, custody: 'unknown' },
    { ...session, inputs: [] },
    { ...session, inputs: [{ phase: 'unknown' }, session.inputs[1]] },
  ])
    assert.throws(() => assertColdOpenCodeRuntimeRecords(source, {}, [changed]));
  assert.throws(() => assertColdOpenCodeRuntimeRecords(source, {}, [session, session]));
});

test('cold metadata retains a child retired during the original read and proves every successor absent on Quit', async () => {
  const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host-birth', command: '/TEST/node' };
  const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' };
  const successor = { ...child, pid: 12, groupId: 12, birth: 'TEST-successor-birth' };
  const latest = { ...child, pid: 13, groupId: 13, birth: 'TEST-latest-birth' };
  const ready: DesktopMetadataEvent = { hostPid: host.pid, profileHash: 'a'.repeat(64), mode: 'directory',
    providerHash: null, pid: child.pid, startIdentityHash: nativeIdentityHash('TEST-native-11'), stage: 'ready' };
  const nextReady: DesktopMetadataEvent = { ...ready, mode: 'provider', providerHash: 'b'.repeat(64),
    pid: successor.pid, startIdentityHash: nativeIdentityHash('TEST-native-12') };
  const lastReady: DesktopMetadataEvent = { ...ready, pid: latest.pid, startIdentityHash: nativeIdentityHash('TEST-native-13') };
  const events: DesktopMetadataEvent[] = [ready, { ...ready, stage: 'released' }, nextReady];
  const first = (values = events, observed = [successor], initialBirths = [child]) => captureDesktopMetadataLineage({
    events: values, host, profileHashes: [ready.profileHash], observed, executable: child.command, initialBirths,
  });
  const captured = { host, children: [successor], metadataLineage: first() };
  assert.deepEqual(captured.metadataLineage.births, [child, successor],
    'the real pre-read birth is retained even when its exact release precedes the first lineage read');
  assert.throws(() => first([nextReady]), /original ready/);
  assert.throws(() => first([ready, nextReady]), /duplicate live/);
  assert.throws(() => first([ready, { ...ready, stage: 'cleanup-unknown' }, nextReady]), /unknown cleanup/);
  assert.throws(() => first([ready, { ...ready, stage: 'released', startIdentityHash: nativeIdentityHash('TEST-foreign') }, nextReady]));
  assert.throws(() => first(events, [child, successor]), /physically absent/);
  assert.throws(() => first([ready], [{ ...child, birth: 'TEST-reused-pid' }]), /birth/);
  assert.throws(() => first([ready, { ...ready, stage: 'released' }, { ...nextReady, profileHash: 'c'.repeat(64) }]), /captured scope/);
  const observedEvents: DesktopMetadataEvent[] = [...events, { ...nextReady, stage: 'released' }, lastReady];
  const readback = { host, children: [latest], metadataLineage: captureDesktopMetadataLineage({
    events: observedEvents, host, profileHashes: [ready.profileHash], observed: [latest], executable: child.command,
    original: captured.metadataLineage,
  }) };
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(captured, readback, 0), []);
  assert.deepEqual(readback.metadataLineage.births, [child, successor, latest]);
  const original = { metadataProcessCount: 1, before: { host, children: [child] }, captured,
    metadataAfterReadback: readback, metadataAtHostClose: { ...readback.metadataLineage,
      events: [...observedEvents, { ...lastReady, stage: 'released' as const }] } };
  const proof: Record<string, unknown> = structuredClone(original);
  const evidence = { hostChild: { pid: host.pid, ppid: 1, pgid: 10 }, coldOpenCodeMetadata: proof };
  for (const birth of [child, successor, latest]) {
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [{ pid: birth.pid, ppid: host.pid, pgid: birth.pid }]));
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [{ pid: birth.pid, ppid: 1, pgid: birth.pid }]));
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [{ pid: birth.pid, ppid: 99, pgid: 99 }]));
    assert.equal(proof.metadataAbsentBeforeHarnessCleanup, undefined, 'an orphan or reused PID never proves absence');
  }
  assert.throws(() => assertCapturedDesktopMetadataAbsent({ ...evidence,
    coldOpenCodeMetadata: { ...original, metadataAtHostClose: readback.metadataLineage } }, []), /confirmed close/);
  assert.throws(() => assertCapturedDesktopMetadataAbsent({ ...evidence,
    coldOpenCodeMetadata: { ...original, metadataAfterReadback: { ...readback,
      host: { ...host, birth: 'TEST-foreign-host' } } } }, []));
  assertCapturedDesktopMetadataAbsent(evidence, [{ pid: 42, ppid: 1, pgid: 42 }]);
  assert.equal(proof.metadataAbsentBeforeHarnessCleanup, true);
  assert.deepEqual(proof.captured, original.captured);
  assert.deepEqual(proof.metadataAfterReadback, original.metadataAfterReadback);
  const absent: Record<string, unknown> = {};
  assertCapturedDesktopMetadataAbsent(absent, []);
  assert.deepEqual(absent, {});
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-metadata-failure-')));
  try {
    const directory = join(root, 'userData/logs');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'app-errors.ndjson');
    const line = (event: unknown) => JSON.stringify({ namespace: 'Host:OpenCodeMetadata',
      message: 'OpenCode metadata stage ' + JSON.stringify(event) });
    await writeFile(path, events.map(line).join('\n') + '\n');
    const expected = [ready.profileHash, 'c'.repeat(64)];
    let originalError: unknown;
    assert.throws(() => {
      try { readDesktopMetadataLineage(root, captured, expected, [successor]); }
      catch (error) { originalError = error; throw error; }
    }, /every selected metadata scope has one live owner/);
    const failure = readDesktopMetadataLineageFailure(originalError);
    assert.ok(failure);
    assert.deepEqual(failure, { hostPid: host.pid, expectedProfileHashes: expected,
      events, observedMetadataPids: [successor.pid] });
    assert.ok(Object.isFrozen(failure) && Object.isFrozen(failure.events) && failure.events.every(Object.isFrozen));
    assert.equal(JSON.stringify(failure).includes(root), false);
    assert.equal(readDesktopMetadataLineageFailure(new Error('same message is not the original read')), undefined);
    await writeFile(path, line({ ...ready, rawPrivateField: 'TEST-unvalidated-line' }));
    assert.throws(() => {
      try { readDesktopMetadataLineage(root, captured, expected, [successor]); }
      catch (error) { assert.equal(readDesktopMetadataLineageFailure(error), undefined); throw error; }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed Quit proves its original detached metadata child absent without adopting an orphan or reused PID', () => {
  const host = { pid: 10, parentPid: 1, groupId: 9, birth: 'TEST-host-birth', command: '/TEST/node' };
  const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' };
  const original = {
    hostChild: { pid: 10, ppid: 1, pgid: 9 },
    mixedCreateLaunchProof: {
      status: 'PASS', openCodeGeneration: 'v2', originalMetadataChildBeforeLaunch: child,
      managementChildBeforeStop: child, managementChildAfterStop: child,
      isolatedMemberRestart: { physical: { originalHost: host, currentHost: host, managementChild: child } },
    },
  };
  for (const current of [
    { pid: 11, ppid: 10, pgid: 11 },
    { pid: 11, ppid: 1, pgid: 11 },
    { pid: 11, ppid: 99, pgid: 99 },
  ]) {
    const evidence = structuredClone(original);
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [current]), /mixed metadata child/);
    assert.equal('managementChildAbsentBeforeHarnessCleanup' in evidence.mixedCreateLaunchProof, false);
  }
  for (const field of ['managementChildBeforeStop', 'managementChildAfterStop']) {
    const evidence = structuredClone(original);
    (evidence.mixedCreateLaunchProof as Record<string, unknown>)[field] = { ...child, birth: 'TEST-replaced' };
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, []));
  }
  const wrongHost = structuredClone(original);
  wrongHost.hostChild.pid = 99;
  assert.throws(() => assertCapturedDesktopMetadataAbsent(wrongHost, []));
  const wrongBinding = structuredClone(original);
  wrongBinding.mixedCreateLaunchProof.originalMetadataChildBeforeLaunch.parentPid = 99;
  assert.throws(() => assertCapturedDesktopMetadataAbsent(wrongBinding, []));
  const evidence = structuredClone(original);
  assertCapturedDesktopMetadataAbsent(evidence, [{ pid: 42, ppid: 1, pgid: 42 }]);
  assert.deepEqual(evidence.mixedCreateLaunchProof,
    { ...original.mixedCreateLaunchProof, managementChildAbsentBeforeHarnessCleanup: true });
  assert.equal('coldOpenCodeMetadata' in evidence, false, 'mixed proof is not a synthetic cold receipt');
});

test('V2 mixed cleanup requires its pre-Launch observation while V1 proof stays unchanged', () => {
  const evidence = { mixedCreateLaunchProof: { status: 'PASS', openCodeGeneration: 'v1' } };
  assertCapturedDesktopMetadataAbsent(evidence, []);
  assert.deepEqual(evidence, { mixedCreateLaunchProof: { status: 'PASS', openCodeGeneration: 'v1' } });
  for (const changed of [
    { status: 'PASS', openCodeGeneration: 'v2' },
    { status: 'PASS' },
    { status: 'PASS', openCodeGeneration: 'v1', originalMetadataChildBeforeLaunch: {} },
  ]) assert.throws(() => assertCapturedDesktopMetadataAbsent({ mixedCreateLaunchProof: changed }, []));
});

test('every hot V2 flow requires its own captured metadata child absent before fallback cleanup', () => {
  const host = { pid: 10, parentPid: 1, groupId: 9, birth: 'TEST-host-birth', command: '/TEST/node' };
  const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' };
  const captured = tracedMetadata({ host, children: [child, { ...child, pid: 12, groupId: 12, birth: 'TEST-project-metadata' }] });
  const flows = [
    { mode: 'native-review-ui', key: 'nativeReviewUiProof', capture: 'originalMetadataBeforeLaunch',
      proof: { status: 'PASS', provider: 'opencode-v2', originalMetadataBeforeLaunch: captured, metadataAfterStop: captured, stop: { metadata: captured.children } } },
    { mode: 'native-launch-ui', key: 'launchDialogProof', capture: 'originalMetadataBeforeLaunch',
      proof: { status: 'PASS', provider: 'opencode', originalMetadataBeforeLaunch: captured, metadataAfterStop: captured } },
    ...['native-stop-ui', 'native-conversation-ui', 'native-quit-ui'].flatMap(mode =>
      (mode === 'native-quit-ui' ? ['ready', 'opening'] : ['ready']).map(status => ({
        mode, key: 'nativeSetup', capture: 'metadataBeforeLaunch', proof: { status, metadataBeforeLaunch: captured },
      }))),
  ];
  for (const flow of flows) {
    const source: Record<string, unknown> = { mode: flow.mode, nativeProvider: 'opencode', nativeGeneration: 'v2',
      hostChild: { pid: 10, ppid: 1, pgid: 9 }, [flow.key]: { ...flow.proof, metadataSources: metadataSources(captured), metadataAtHostClose: closedMetadata(captured) } };
    for (const current of [11, 12].flatMap(pid => [{ pid, ppid: 10, pgid: pid }, { pid, ppid: 1, pgid: pid }, { pid, ppid: 99, pgid: 99 }])) {
      const evidence = structuredClone(source), proof = evidence[flow.key] as Record<string, unknown>;
      assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [current]), /metadata child/);
      assert.equal(proof.metadataAbsentBeforeHarnessCleanup, undefined);
    }
    for (const change of [
      (evidence: Record<string, unknown>) => { delete (evidence[flow.key] as Record<string, unknown>)[flow.capture]; },
      (evidence: Record<string, unknown>) => { delete (evidence[flow.key] as Record<string, unknown>).metadataSources; },
      (evidence: Record<string, unknown>) => { delete (evidence[flow.key] as Record<string, unknown>).metadataAtHostClose; },
      (evidence: Record<string, unknown>) => {
        const sources = (evidence[flow.key] as Record<string, unknown>).metadataSources as Record<string, unknown>[];
        sources[1]!.profileId = sources[0]!.profileId;
      },
      (evidence: Record<string, unknown>) => {
        const sources = (evidence[flow.key] as Record<string, unknown>).metadataSources as Record<string, unknown>[];
        sources[1]!.process = { ...(sources[1]!.process as object), birth: 'TEST-replaced-owner' };
      },
      (evidence: Record<string, unknown>) => { delete evidence.nativeGeneration; },
      (evidence: Record<string, unknown>) => { evidence.nativeProvider = 'claude'; },
      (evidence: Record<string, unknown>) => { evidence.hostChild = { pid: 99, ppid: 1, pgid: 9 }; },
      (evidence: Record<string, unknown>) => {
        (evidence[flow.key] as Record<string, unknown>)[flow.capture] = { host, children: [{ ...child, parentPid: 99 }] };
      },
    ]) {
      const evidence = structuredClone(source); change(evidence);
      assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, []));
    }
    const evidence = structuredClone(source);
    assertCapturedDesktopMetadataAbsent(evidence, [{ pid: 42, ppid: 1, pgid: 42 }]);
    assert.equal((evidence[flow.key] as Record<string, unknown>).metadataAbsentBeforeHarnessCleanup, true);
  }
});

test('cold Resume records first metadata absence before the second spawn and binds the second epoch separately', () => {
  const capture = (pid: number) => ({
    host: { pid, parentPid: 1, groupId: pid - 1, birth: 'TEST-host-' + pid, command: '/TEST/node' },
    children: [1, 2].map(offset => ({ pid: pid + offset, parentPid: pid, groupId: pid + offset,
      birth: 'TEST-metadata-' + (pid + offset), command: '/TEST/bun' })),
  });
  const first = tracedMetadata(capture(10)), second = tracedMetadata(capture(20));
  const launch: Record<string, unknown> = { provider: 'opencode', status: 'INCOMPLETE', stop: { releasedBeforeQuit: true },
    originalMetadataBeforeLaunch: first, metadataAfterStop: first, metadataSources: metadataSources(first), metadataAtHostClose: closedMetadata(first) };
  const boundary: Record<string, unknown> = { provider: 'opencode', status: 'INCOMPLETE',
    firstEpoch: { host: { pid: 10, ppid: 1, pgid: 9 } },
    firstCleanup: { appExitCode: 0, appSignalCode: null, remaining: [], capturedHostAbsent: true, writerLockReleased: true } };
  const evidence: Record<string, unknown> = { mode: 'native-resume-ui', nativeProvider: 'opencode', nativeGeneration: 'v2',
    launchDialogProof: launch, coldResumeBoundary: boundary };
  for (const current of [11, 12].flatMap(pid => [{ pid, ppid: 10, pgid: pid }, { pid, ppid: 1, pgid: pid }, { pid, ppid: 99, pgid: 99 }])) {
    assert.throws(() => assertFirstResumeMetadataAbsent(evidence, [current]), /first Resume metadata child/);
    assert.equal(boundary.firstMetadataAbsentBeforeSecondSpawn, undefined);
  }
  for (const changed of [
    { ...boundary, secondEpoch: {} },
    { ...boundary, firstEpoch: { host: { pid: 99, ppid: 1, pgid: 9 } } },
    { ...boundary, firstCleanup: { ...(boundary.firstCleanup as object), appSignalCode: 'SIGTERM' } },
  ]) assert.throws(() => assertFirstResumeMetadataAbsent({ ...evidence, coldResumeBoundary: changed }, []));
  assertFirstResumeMetadataAbsent(evidence, []);
  assert.equal(boundary.firstMetadataAbsentBeforeSecondSpawn, true);
  launch.status = 'PASS'; boundary.status = 'PASS';
  boundary.secondEpoch = { host: { pid: 20, ppid: 1, pgid: 19 } };
  evidence.hostChild = { pid: 20, ppid: 1, pgid: 19 };
  const resume: Record<string, unknown> = { provider: 'opencode', status: 'PASS',
    originalMetadataBeforeResume: second, metadataAfterSecondStop: second, metadataSources: metadataSources(second), metadataAtHostClose: closedMetadata(second) };
  evidence.resumeDialogProof = resume;
  for (const current of [21, 22].flatMap(pid => [{ pid, ppid: 20, pgid: pid }, { pid, ppid: 1, pgid: pid }, { pid, ppid: 99, pgid: 99 }])) {
    assert.throws(() => assertCapturedDesktopMetadataAbsent(evidence, [current]), /second Resume metadata child/);
    assert.equal(resume.metadataAbsentBeforeHarnessCleanup, undefined);
  }
  assert.throws(() => assertCapturedDesktopMetadataAbsent({ ...evidence,
    coldResumeBoundary: { ...boundary, firstMetadataAbsentBeforeSecondSpawn: undefined } }, []));
  assert.throws(() => assertCapturedDesktopMetadataAbsent({ ...evidence,
    resumeDialogProof: { ...resume, originalMetadataBeforeResume: first, metadataAfterSecondStop: first } }, []));
  assert.throws(() => assertCapturedDesktopMetadataAbsent({ ...evidence, hostChild: { pid: 10, ppid: 1, pgid: 9 } }, []));
  assertCapturedDesktopMetadataAbsent(evidence, []);
  assert.equal(resume.metadataAbsentBeforeHarnessCleanup, true);
  assert.throws(() => assertFirstResumeMetadataAbsent(evidence, []), /before the second app spawn/);
  const legacy = { mode: 'native-resume-ui', resumeProvider: 'claude', launchDialogProof: { provider: 'claude' } };
  const unchanged = structuredClone(legacy); assertFirstResumeMetadataAbsent(legacy, []);
  assertCapturedDesktopMetadataAbsent(legacy, []); assert.deepEqual(legacy, unchanged);
});

test('cold metadata preserves only the exact pending-open UNKNOWN witnessed by original Quit', () => {
  const session = {
    phase: 'held',
    custody: 'unknown',
    diagnostic: 'open-unknown',
    sealed: true,
    nativeReady: false,
    inputs: [],
    interactions: [],
  };
  const proof = {
    status: 'PASS',
    scenario: 'pending-open',
    afterQuit: {
      session: structuredClone(session),
      runtimeOutcome: 'held-unknown',
      debtRetained: true,
      originalGroupAbsentBeforeHarnessCleanup: true,
      nativeChildrenAbsent: true,
    },
  };
  const source = { mode: 'native-quit-ui', nativeQuitUiProof: proof };
  assert.doesNotThrow(() => assertColdOpenCodeRuntimeRecords(source, {}, [session]));
  assert.throws(() =>
    assertColdOpenCodeRuntimeRecords(source, {}, [
      { ...session, phase: 'closed', custody: 'released' },
    ])
  );
  for (const changed of [
    { ...proof, scenario: 'active' },
    { ...proof, afterQuit: { ...proof.afterQuit, debtRetained: false } },
    { ...proof, afterQuit: { ...proof.afterQuit, nativeChildrenAbsent: false } },
    { ...proof, afterQuit: { ...proof.afterQuit, originalGroupAbsentBeforeHarnessCleanup: false } },
  ])
    assert.throws(() =>
      assertColdOpenCodeRuntimeRecords({ ...source, nativeQuitUiProof: changed }, {}, [session])
    );
  const foreign = { ...session, inputs: [{ phase: 'claimed' }] };
  assert.throws(() =>
    assertColdOpenCodeRuntimeRecords(
      {
        ...source,
        nativeQuitUiProof: {
          ...proof,
          afterQuit: { ...proof.afterQuit, session: foreign },
        },
      },
      {},
      [foreign]
    )
  );
});

test('V2 Quit oracle holds one actual HTTP request and records its original disconnect', async () => {
  const model = await startOpenCodeModel({ nativeGeneration: 'v2', memberName: 'alice',
    uiGeneratedMessageIds: true, holdInitialTurnResponse: true });
  const abort = new AbortController();
  const pending = fetch(model.url + '/v1/chat/completions', { method: 'POST', signal: abort.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'TEST-model', tools,
      messages: [{ role: 'system', content: CONTEXT_MARKER }, user('OPENCODE_TEAM_ONE')] }) }).catch(() => undefined);
  try {
    await until(() => model.heldInitialRequests?.length === 1);
    assert.equal(model.observations.length, 1);
    assert.equal(model.observations[0]!.visibleReplyContract, true);
    assert.equal(model.observations[0]!.incomingMessageId, messageId);
    assert.equal(model.heldInitialRequests![0]!.disconnected, false);
    abort.abort(); await pending;
    await until(() => model.heldInitialRequests![0]!.disconnected);
    assert.deepEqual(model.failures, []);
  } finally { abort.abort(); await pending; await model.close(); }
});

test('V2 Resume oracle measures original tool IDs from the incoming native request', async () => {
  const model = await startOpenCodeModel({ nativeGeneration: 'v2', memberName: 'alice',
    uiGeneratedMessageIds: true, captureHistoryMarkers: true });
  const ids = Array.from({ length: 7 }, (_, index) => `TEST_OPENCODE_TEAM_ONE_${index}`);
  try {
    const response = await fetch(model.url + '/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'TEST-model', tools,
        messages: [{ role: 'system', content: CONTEXT_MARKER }, user('OPENCODE_TEAM_ONE'),
          { role: 'assistant', tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'shell', arguments: '{}' } })) },
          user('OPENCODE_TEAM_TWO')] }) });
    assert.equal(response.status, 200); await response.text();
    const observation = model.observations[0]!;
    assert.deepEqual(observation.priorNativeToolIds, ids);
    assert.equal(observation.incomingMessageId, messageId);
    assert.equal(observation.visibleReplyContract, true);
    assert.equal(originalHistoryMarker(ids, 'opencode'), jsonDigest(ids));
    assert.throws(() => originalHistoryMarker(ids.slice(1), 'opencode'));
    assert.deepEqual(model.failures, []);
  } finally { await model.close(); }
});

test('V2 checkpoint evidence reads only its exact captured SQLite session and rejects foreign identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  try {
    const binding = { backendId: 'TEST-host', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'alice-id', generation: '1' };
    const config = { sessionId: 'TEST-runtime-session' }, accountBinding = 'TEST-account';
    const nativeSessionId = 'ses_' + jsonDigest({ sessionId: config.sessionId, memberId: binding.memberId, accountBinding }).slice(0, 40);
    const data = join(root, 'providers/opencode-v2/data'), cwd = join(root, 'workspace');
    const directory = join(data, 'agent-teams-v2-' + jsonDigest({ teamId: binding.teamId,
      memberId: binding.memberId, sessionId: config.sessionId }).slice(0, 32));
    await mkdir(directory, { recursive: true }); await mkdir(cwd);
    await writeFile(join(root, 'host-profile.json'), JSON.stringify({ runtime: { members: [{
      provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
      teamId: binding.teamId, memberId: binding.memberId, accountBinding, cwd,
      environment: { XDG_DATA_HOME: data },
    }] } }));
    const databasePath = join(directory, 'opencode.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT, version TEXT); CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)');
    database.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run(nativeSessionId, cwd, '2.1.4');
    database.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?)').run('TEST-event', nativeSessionId, 1, 'session.message', JSON.stringify({ text: 'OPENCODE_TEAM_ONE' }));
    database.close();
    const checkpointId = 'TEST-checkpoint', reference = `cp1-${jsonDigest({ binding, checkpointId })}`;
    const historyDigest = jsonDigest({ baseline: null, operations: [] });
    const body = { reference, checkpointId, sourceSessionRef: 'TEST-session', sourceBinding: binding,
      sourceConfig: config, completedOperations: [], historyDigest,
      opaque: { version: 1, engine: 'opencode-v2', nativeSessionId, compatibility: 'a'.repeat(64) } };
    const payload = { ...body, digest: jsonDigest(body) };
    await mkdir(join(root, 'hoststore/runtime-checkpoints'), { recursive: true });
    await writeFile(join(root, 'hoststore/runtime-checkpoints', reference + '.json'), JSON.stringify(payload));
    const session = { binding, config, sessionRef: 'TEST-session', phase: 'closed', custody: 'released', inputs: [],
      checkpoints: [{ status: 'published', reference, payloadDigest: payload.digest, historyDigest }] };
    const before = await readFile(databasePath);
    const observed = await checkpoint(root, session, 'opencode');
    assert.equal(observed.nativeSession, nativeSessionId); assert.equal(observed.historyPath, databasePath);
    assert.ok(observed.history.includes(Buffer.from('OPENCODE_TEAM_ONE')));
    assert.deepEqual(await readFile(databasePath), before, 'evidence performs no database write');
    await assert.rejects(checkpoint(root, { ...session, custody: 'unknown' }, 'opencode'));
    const foreign = new DatabaseSync(databasePath);
    foreign.prepare('UPDATE session_v2 SET directory = ?').run(join(root, 'foreign'));
    foreign.close();
    await assert.rejects(checkpoint(root, session, 'opencode'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
