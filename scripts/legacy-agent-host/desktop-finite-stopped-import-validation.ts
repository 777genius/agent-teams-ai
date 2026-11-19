import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { stoppedImportSourceBytes } from './desktop-stopped-import-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { finiteImportRecords } from './desktop-finite-stopped-import-ui.ts';
import { FINITE_IMPORT_MODE, FINITE_SOURCE_TEAM, FINITE_SOURCE_PROMPT, FINITE_SOURCE_REPLY,
  FINITE_HOST_PROMPT, finiteImportJson as json, finiteImportRow as row, readFiniteLegacyEffects,
  assertFiniteImportInputCorrelation, type FiniteImportRow } from './desktop-finite-stopped-import-fixture.ts';

/** Immutable receipt validation only. No launch, import mutation, recovery or process signaling. */
export async function validateDesktopFiniteStoppedImport(root: string, receipt: FiniteImportRow) {
  assert.equal(await realpath(root), root); assert.equal(receipt.mode, FINITE_IMPORT_MODE); assert.equal(receipt.status, 'PASS');
  const proof = row(receipt.finiteStoppedImportUiProof), source = row(receipt.finiteStoppedProducer);
  assert.equal(proof.status, 'PASS'); assert.equal(source.status, 'PASS');
  assert.equal(proof.sourceKind, 'actual-current-finite-solo'); assert.equal(source.sourceKind, proof.sourceKind);
  assert.equal(proof.execution, 'finite-protocol-peer'); assert.equal(source.execution, 'finite-legacy-bootstrap-protocol');
  assert.equal(source.hostDescriptorPresent, false); assert.equal(source.inputsFrozen, true);
  assert.equal(source.freezeFailure, undefined); assert.equal(source.sourcePeerAbsentAfterCleanup, true);
  assert.equal(source.sourceIdentityObservationFailed, undefined);
  assert.equal(row(source.cleanup).cleanupFailure, undefined); assert.deepEqual(row(source.cleanup).remaining, []);
  assert.deepEqual(source.ordinaryQuit, { requestedOnce: true, exitCode: 0, signalCode: null,
    originalGroupAbsent: true, listenerAbsent: true, sourcePeerAbsent: true });
  assert.ok(Array.isArray(source.steps) && source.steps.length > 0);
  assert.ok(Array.isArray(proof.steps) && proof.steps.length > 0);
  for (const value of [source, proof]) {
    assert.ok(Array.isArray(value.excluded));
    for (const exclusion of ['genuine historical donor frontend', 'vendor CLI/inference/auth qualification', 'multi-member or Windows source release'])
      assert.ok(value.excluded.includes(exclusion));
  }
  const seedPath = join(root, 'finite-stopped-import-seed.json'), seed = await json(seedPath);
  assert.equal(await fileDigest(seedPath), proof.seedSha256); assert.equal(seed.sourceKind, source.sourceKind);
  assert.equal(seed.teamName, FINITE_SOURCE_TEAM);
  const producerPath = join(root, 'finite-stopped-import-producer.json');
  assert.deepEqual(seed.producer, { path: producerPath, sha256: await fileDigest(producerPath) });
  assert.deepEqual(proof.sourceProducer, seed.producer); assert.deepEqual(await json(producerPath), source);
  assert.equal(row(row(source.originalStopDiagnostics).canonicalNodeRead).canonicalReleaseCurrent, true);
  assert.equal(row(row(source.originalStopDiagnostics).canonicalNodeRead).proofParseable, true);
  const release = row(source.sourceRelease), target = row(release.target), child = row(source.liveSourceChild);
  assert.equal(release.version, 1); assert.equal(release.kind, 'desktop-owned-unix-cli');
  assert.equal(target.teamName, FINITE_SOURCE_TEAM); assert.equal(target.runId, seed.sourceRunId);
  assert.equal(target.sessionId, seed.sourceSessionId); assert.equal(target.rootPid, child.pid);
  assert.equal(child.pid, child.pgid); assert.equal(row(release.process).rootStartIdentity, child.startIdentity);
  assert.equal(row(release.process).processGroupId, child.pid);
  assert.deepEqual(row(source.sourceStopped).nativeRelease, release);
  assert.deepEqual((await json(join(root, 'claude/teams', FINITE_SOURCE_TEAM, 'launch-stopped.json'))).nativeRelease, release);
  const originalEffects = await readFiniteLegacyEffects(root); assert.deepEqual(originalEffects, source.sourceEffects);
  const bootstraps = originalEffects.filter(value => value.event === 'bootstrap');
  const turns = originalEffects.filter(value => value.event === 'turn-completed');
  assert.equal(bootstraps.length, 1); assert.equal(turns.length, 1);
  for (const effect of [bootstraps[0]!, turns[0]!]) {
    assert.equal(effect.pid, child.pid); assert.equal(effect.runId, seed.sourceRunId); assert.equal(effect.sessionId, seed.sourceSessionId);
    assert.equal(effect.prompt, FINITE_SOURCE_PROMPT);
  }
  assert.equal(turns[0]!.reply, FINITE_SOURCE_REPLY);
  assert.equal(bootstraps[0]!.transcriptPath, seed.transcriptPath);
  assert.equal(bootstraps[0]!.parentPid, child.ppid); assert.equal(bootstraps[0]!.mainOwnerPid, child.ppid);
  assert.ok(Array.isArray(child.ancestry) && child.ancestry.includes(child.ppid));
  const executable = row(source.executable);
  assert.equal(executable.path, join(root, 'bin/TEST-legacy-bootstrap-peer'));
  for (const [path, digest] of [[executable.path, executable.sha256], [executable.source, executable.sourceSha256]]) {
    assert.equal(await realpath(String(path)), path); assert.equal(await fileDigest(String(path)), digest);
  }
  assert.deepEqual(seed.roots, [join(root, 'claude/teams', FINITE_SOURCE_TEAM), join(root, 'claude/tasks', FINITE_SOURCE_TEAM), dirname(String(seed.transcriptPath))]);
  assert.deepEqual(seed.absentRoots, [join(root, 'userData/data/attachments', FINITE_SOURCE_TEAM), join(root, 'userData/data/task-attachments', FINITE_SOURCE_TEAM)]);
  for (const path of seed.absentRoots as string[]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.deepEqual(await stoppedImportSourceBytes(root, seed.roots as string[]), seed.before);
  assert.deepEqual(proof.sourceBefore, seed.before); assert.deepEqual(proof.sourceAfter, seed.before);
  const imports = await finiteImportRecords(join(root, 'hoststore/.host-team-registry/imports'));
  assert.deepEqual(imports, [proof.importRecord]); assert.equal(row(proof.importRecord).phase, 'published');
  const imported = row(row(proof.importRecord).record);
  assert.equal(imported.teamName, FINITE_SOURCE_TEAM);
  assert.equal(row(proof.lookup).selection, 'host-team:' + encodeURIComponent(String(row(imported.binding).handleId)));
  const task = row(seed.sourceTask);
  assert.deepEqual(proof.importedTask, task);
  assert.deepEqual(await json(join(root, 'hoststore/tasks', FINITE_SOURCE_TEAM, String(task.id) + '.json')), task);
  assert.equal(proof.originalLookupRetained, true); assert.deepEqual(proof.runtimeSessionsBeforeLaunch, []);
  assert.equal(proof.sourcePromptReplays, 0); assert.equal(proof.freshInputCount, 1);
  const capture = row(proof.capture), input = row(proof.freshInput);
  assert.notEqual(capture.launchId, seed.sourceRunId); assert.notEqual(input.sessionId, seed.sourceSessionId);
  assert.equal(input.marker, FINITE_HOST_PROMPT); assert.equal(input.role, 'runtime');
  const before = row(proof.sessionBeforeStop), after = row(proof.sessionAfterStop);
  assert.equal(row(before.binding).runId, capture.launchId); assert.equal(row(after.binding).runId, capture.launchId);
  assert.equal(after.phase, 'closed'); assert.equal(after.custody, 'released');
  assert.ok(Array.isArray(after.inputs) && after.inputs.length === 1);
  const terminal = row(after.inputs[0]); assert.equal(terminal.phase, 'terminal'); assert.equal(terminal.terminal, 'succeeded');
  assert.deepEqual(after.inputs, before.inputs); assert.deepEqual(after.binding, before.binding);
  assert.equal(row(proof.stop).runtimePid, input.pid); assert.equal(row(proof.stop).releasedBeforeQuit, true); assert.equal(row(proof.stop).peerAbsent, true);
  const cleanup = row(receipt.emulatedRuntimeCleanup);
  assert.equal(cleanup.absent, true); assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.observationFailed, undefined);
  assert.ok(Array.isArray(cleanup.originalPeerPids) && cleanup.originalPeerPids.includes(input.pid));
  assert.ok(Array.isArray(cleanup.effects));
  const correlationOptions = { capture, effects: cleanup.effects.map(row),
    host: row(receipt.hostChildAfterImport), sourceSessionId: seed.sourceSessionId };
  assert.deepEqual(assertFiniteImportInputCorrelation({ ...correlationOptions, session: before }), proof.inputCorrelation);
  assert.deepEqual(assertFiniteImportInputCorrelation({ ...correlationOptions, session: after }), proof.inputCorrelation);
  assert.equal(row(receipt.hostChild).pid, correlationOptions.host.pid);
  assert.deepEqual(cleanup.effects.filter(value => row(value).event === 'input' && row(value).marker !== 'TEST_MODEL_PROBE'), [input]);
  assert.ok(cleanup.effects.every(value => row(value).provider === 'claude' &&
    ['management', 'runtime'].includes(String(row(value).role)) && row(value).event !== 'failure'));
  const births = cleanup.effects.filter(value => row(value).event === 'launch'); assert.ok(births.length > 0);
  for (const value of births) {
    const birth = row(value); assert.equal(birth.parentPid, row(receipt.hostChild).pid);
    assert.ok(Number.isSafeInteger(birth.pid) && Number(birth.pid) > 1 && cleanup.originalPeerPids.includes(birth.pid));
  }
  const pins = row(proof.fixturePins);
  assert.equal(pins.provider, 'claude'); assert.equal(pins.protocolRevision, 'sdk-0.3.305');
  assert.equal(pins.runtimeConfigured, true); assert.equal(pins.managementConfigured, true); assert.equal(pins.vendorsAllowed, false);
  assert.ok(Array.isArray(pins.sources) && pins.sources.length > 0);
  for (const value of [...pins.sources, pins.executable]) {
    const pin = row(value); assert.equal(await realpath(String(pin.path)), pin.path);
    assert.equal(await fileDigest(String(pin.path)), pin.sha256);
  }
  assert.deepEqual(await readDesktopNativeStopSessions(root), [after]);
  const owner = await json(join(root, 'hoststore/teams', FINITE_SOURCE_TEAM, '.host-owner/state.json'));
  assert.deepEqual(owner.runtimeCaptures, [capture]); assert.equal(row(owner.savedSettings).prompt, FINITE_HOST_PROMPT);
  for (const [key, value] of Object.entries(row(seed.savedSettings)))
    if (key !== 'prompt') assert.deepEqual(row(owner.savedSettings)[key], value);
  const screenshots = [row(source.sourceScreenshot), ...['importedDialogScreenshot', 'reloadedDialogScreenshot',
    'taskScreenshot', 'freshLaunchScreenshot', 'stoppedReloadScreenshot'].map(key => row(proof[key]))];
  for (const screenshot of screenshots) {
    const path = String(screenshot.path); assert.equal(dirname(await realpath(path)), root);
    const bytes = await readFile(path); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(bytes.readUInt32BE(16) >= 640 && bytes.readUInt32BE(20) >= 480);
    assert.equal(await fileDigest(path), screenshot.sha256);
  }
  return screenshots;
}
