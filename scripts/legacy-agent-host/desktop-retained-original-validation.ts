import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { finiteImportJson as json, finiteImportRow as row } from './desktop-finite-stopped-import-fixture.ts';
import { finiteImportRecords } from './desktop-finite-stopped-import-ui.ts';
import { RETAINED_ORIGINAL_KIND, RETAINED_ORIGINAL_MODE, RETAINED_ORIGINAL_TEAM,
  RETAINED_ORIGINAL_PROMPT, RETAINED_ORIGINAL_REPLY, readRetainedOriginalEffects } from './desktop-retained-original-fixture.ts';

/** Read-only validation of original observations; this never creates a source or release receipt. */
export async function validateDesktopRetainedOriginal(root: string, receipt: Record<string, unknown>) {
  assert.equal(await realpath(root), root); assert.equal(receipt.mode, RETAINED_ORIGINAL_MODE); assert.equal(receipt.status, 'PASS');
  const proof = row(receipt.retainedOriginalUiProof), seedPath = join(root, 'retained-original-archive.json'), seed = await json(seedPath);
  assert.equal(proof.status, 'PASS'); assert.equal(proof.sourceKind, RETAINED_ORIGINAL_KIND); assert.equal(seed.sourceKind, RETAINED_ORIGINAL_KIND);
  assert.equal(proof.execution, 'finite-legacy-launch-protocol'); assert.equal(proof.hostDescriptorPresent, true);
  assert.equal(proof.inputsFrozen, true); assert.equal(proof.peerAbsentAfterCleanup, true);
  assert.equal(proof.sourceIdentityObservationFailed, undefined); assert.equal(proof.cleanupFailure, undefined);
  assert.equal(seed.version, 1); assert.equal(seed.teamName, RETAINED_ORIGINAL_TEAM); assert.equal(seed.workspace, join(root, 'workspace'));
  assert.equal(await fileDigest(seedPath), proof.seedSha256);
  assert.deepEqual(seed.absent, ['launch-state.json', 'launch-stopped.json', 'launch-freshness.json']);
  const descriptor = row(seed.hostDescriptor);
  assert.equal(descriptor.path, join(root, 'desktop-descriptor.json'));
  assert.equal(await fileDigest(String(descriptor.path)), descriptor.sha256);
  const executable = row(proof.executable); assert.equal(executable.path, join(root, 'bin/TEST-retained-bootstrap-peer'));
  for (const [path, sha256] of [[executable.path, executable.sha256], [executable.source, executable.sourceSha256]]) {
    assert.equal(await realpath(String(path)), path); assert.equal(await fileDigest(String(path)), sha256);
  }
  const effects = await readRetainedOriginalEffects(root); assert.deepEqual(effects, proof.sourceEffects);
  const starts = effects.filter(value => value.event === 'bootstrap'), turns = effects.filter(value => value.event === 'turn-completed');
  assert.deepEqual(starts, [proof.bootstrap]); assert.deepEqual(turns, [proof.turn]);
  const bootstrap = row(proof.bootstrap), turn = row(proof.turn), child = row(proof.liveOriginalChild);
  const launch = row(proof.originalLaunch), stopped = row(proof.originalStopped), release = row(stopped.nativeRelease);
  const target = row(release.target), process = row(release.process), configBefore = row(seed.config);
  assert.equal(bootstrap.pid, child.pid); assert.equal(child.pid, child.pgid);
  assert.equal(bootstrap.mainOwnerPid, child.ppid); assert.equal(bootstrap.parentPid, child.ppid);
  assert.ok(Array.isArray(child.ancestry) && child.ancestry.includes(child.ppid) && child.ancestry.includes(proof.capturedAppGroup));
  for (const value of [bootstrap, turn]) {
    assert.equal(value.pid, child.pid); assert.equal(value.runId, launch.publicationRunId);
    assert.equal(value.sessionId, launch.leadSessionId); assert.equal(value.prompt, RETAINED_ORIGINAL_PROMPT);
  }
  assert.equal(turn.reply, RETAINED_ORIGINAL_REPLY);
  assert.equal(bootstrap.previousSessionId, configBefore.leadSessionId); assert.notEqual(bootstrap.sessionId, configBefore.leadSessionId);
  assert.equal(release.version, 1); assert.equal(release.kind, 'desktop-owned-unix-cli');
  assert.equal(target.teamName, RETAINED_ORIGINAL_TEAM); assert.equal(target.runId, launch.publicationRunId);
  assert.equal(target.sessionId, launch.leadSessionId); assert.equal(target.rootPid, child.pid);
  assert.equal(process.rootStartIdentity, child.startIdentity); assert.equal(process.processGroupId, child.pid);
  const team = join(root, 'claude/teams', RETAINED_ORIGINAL_TEAM);
  assert.deepEqual(await json(join(team, 'launch-stopped.json')), stopped);
  const config = await json(join(team, 'config.json'));
  for (const key of ['name', 'description', 'createdAt', '_backupIdentityId']) assert.deepEqual(config[key], configBefore[key]);
  assert.equal(config.leadSessionId, launch.leadSessionId);
  const transcript = await readFile(String(bootstrap.transcriptPath), 'utf8');
  assert.ok(transcript.includes(RETAINED_ORIGINAL_REPLY) && transcript.includes(String(launch.leadSessionId)));
  assert.ok(Array.isArray(proof.originalReadEffects));
  assert.ok(proof.originalReadEffects.some(value => row(value).event === 'metadata-control' && row(value).operation === 'runtime'));
  assert.ok(proof.originalReadEffects.some(value => row(value).event === 'metadata-control' && row(value).operation === 'model'));
  assert.ok(proof.originalReadEffects.every(value => !['bootstrap', 'turn-completed'].includes(String(row(value).event))));
  assert.deepEqual(proof.stop, { peerAbsent: true, releasedBeforeQuit: true });
  assert.equal(proof.hostBusinessInputs, 0); assert.equal(proof.hostImports, 0);
  assert.deepEqual(await finiteImportRecords(join(root, 'hoststore/.host-team-registry/imports'), true), []);
  const cleanup = row(receipt.emulatedRuntimeCleanup); assert.equal(cleanup.absent, true); assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.observationFailed, undefined); assert.ok(Array.isArray(cleanup.effects));
  assert.ok(cleanup.effects.every(value => !['input', 'failure'].includes(String(row(value).event))));
  assert.ok(Array.isArray(proof.steps));
  for (const label of ['choose original runtime explicitly once', 'submit original scoped Launch exactly once', 'original Main Stop exactly once'])
    assert.equal(proof.steps.filter(value => row(value).action === 'mouseClick' && row(value).label === label).length, 1);
  assert.ok(Array.isArray(proof.excluded));
  for (const exclusion of ['genuine historical donor frontend', 'vendor CLI/inference/auth qualification', 'multi-member or Windows source release'])
    assert.ok(proof.excluded.includes(exclusion));
  const pins = row(proof.fixturePins); assert.equal(pins.vendorsAllowed, false); assert.equal(pins.provider, 'claude');
  const screenshots = ['choiceScreenshot', 'readyScreenshot', 'replyScreenshot', 'stoppedScreenshot'].map(key => row(proof[key]));
  for (const screenshot of screenshots) {
    const path = String(screenshot.path); assert.equal(dirname(await realpath(path)), root);
    const bytes = await readFile(path); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(bytes.readUInt32BE(16) >= 640 && bytes.readUInt32BE(20) >= 480);
    assert.equal(await fileDigest(path), screenshot.sha256);
  }
  return screenshots;
}
