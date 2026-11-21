/** TEST finite cold checkpoint Resume followed by one independent fresh source-B Launch. */
import assert from 'node:assert/strict';

import type { RuntimeSourceSummary } from '@agent-teams/legacy-agent-host/runtime-sources';
import type { Job } from './nativeEmulatedSourceScenario';

type Row = Record<string, unknown>;
interface ColdLaunch {
  launchId: string;
  generation: string;
  job: Job;
  entry: Row;
  captureDigest: string;
}
interface ColdJourney {
  cold: {
    rpc(team: number, method: string, commandId: string, payload: unknown): Promise<Row>;
    jobs: Job[];
    sources: { current(): Promise<RuntimeSourceSummary> };
  };
  teamA: Pick<ColdLaunch, 'launchId' | 'generation' | 'entry'>;
  sourceA: RuntimeSourceSummary;
  sourceB: RuntimeSourceSummary;
  teamId: string;
  checkpoint: Row;
  stoppedCheckpoint: Row;
  beforeColdInputs: Row[];
  inputA: string;
  entries(): Row[];
  effects(): Row[];
  inputs(): Row[];
  jobEntry(job: Job, event: 'peer'): Row;
  assertSourceJobs(jobs: Job[], source: RuntimeSourceSummary, image: 'A' | 'B',
    kind: 'management' | 'runtime', teamId?: string): void;
  boot(commandId: string, generation: string): Promise<string>;
  launchFresh(): Promise<ColdLaunch>;
  stage(value: string): void;
  evidence: Row;
}

/** Epoch creation, physical ownership and final cleanup stay with the original scenario. */
export async function nativeEmulatedSourceCold({ cold, teamA, sourceA, sourceB, teamId,
  checkpoint, stoppedCheckpoint, beforeColdInputs, inputA, entries, effects, inputs,
  jobEntry, assertSourceJobs, boot, launchFresh, stage, evidence }: ColdJourney): Promise<void> {
  evidence.stoppedCheckpoint = stoppedCheckpoint;
  stage('cold-Claude-restore-A');
  const restoreInput = { memberId: 'alice-id', reference: checkpoint.reference, expectedGeneration: teamA.generation };
  const restored = await cold.rpc(0, 'runtime.restore', 'TEST-restore-A', restoreInput);
  assert.equal(cold.jobs.length, 1);
  evidence.restoredJobCount = cold.jobs.length;
  assert.equal(restored.nativeReady, true); const generation = restored.generation;
  assert.ok(typeof generation === 'string');
  assert.notEqual(generation, teamA.generation);
  assertSourceJobs(cold.jobs, sourceA, 'A', 'runtime', teamId);
  const original = effects().find(value => value.event === 'initialized' && value.pid === teamA.entry.pid); assert.ok(original);
  const restoredJob = cold.jobs.filter(job => !job.released); assert.equal(restoredJob.length, 1);
  const restoredEntry = jobEntry(restoredJob[0]!, 'peer');
  const initialized = effects().filter(value => value.event === 'initialized' && value.pid === restoredEntry.pid);
  assert.equal(initialized.length, 1); assert.equal(initialized[0]!.restored, true);
  assert.equal(initialized[0]!.sessionId, original.sessionId); assert.deepEqual(inputs(), beforeColdInputs);
  const warmInputs = beforeColdInputs.filter(value =>
    value.pid === teamA.entry.pid && value.marker === 'TEST_UI_BOOT');
  assert.equal(warmInputs.length, 1);
  const warmNativeInputId = warmInputs[0]!.inputId;
  assert.ok(typeof warmNativeInputId === 'string' && warmNativeInputId.length > 0);
  const started = effects().filter(value => value.event === 'started' &&
    value.pid === restoredEntry.pid && value.sessionId === initialized[0]!.sessionId && value.restored === true);
  assert.equal(started.length, 1);
  const resumedHistory = started[0]!.resumedHistory;
  assert.ok(resumedHistory !== null && typeof resumedHistory === 'object' && !Array.isArray(resumedHistory));
  const history = resumedHistory as Row;
  assert.equal(history.bootRetained, true);
  assert.ok(Array.isArray(history.userIds));
  const originalInputRetained = history.userIds.includes(warmNativeInputId);
  assert.equal(originalInputRetained, true);
  evidence.retainedNativeHistory = {
    warmNativeInputId, restoredPid: restoredEntry.pid, sessionId: initialized[0]!.sessionId,
    restored: started[0]!.restored, bootRetained: history.bootRetained, originalInputRetained,
  };
  const restoredJobs = cold.jobs.length, restoredEntries = entries();
  assert.deepEqual(await cold.sources.current(), sourceB);
  assert.deepEqual(await cold.rpc(0, 'runtime.restore', 'TEST-restore-A', restoreInput), restored);
  assert.equal(cold.jobs.length, restoredJobs); assert.deepEqual(entries(), restoredEntries);
  assert.deepEqual(inputs(), beforeColdInputs);
  const restoredInput = await boot('TEST-restored-A-new-input', generation);
  assert.equal(inputs().length, beforeColdInputs.length + 1);
  const stopped = await cold.rpc(0, 'runtime.stop', 'TEST-stop-restored-A', { memberId: 'alice-id', expectedGeneration: generation });
  assert.equal(stopped.phase, 'closed'); assert.equal(stopped.custody, 'released');
  Object.assign(evidence, { sdkPeerCheckpointRestored: true, originalNativeSessionRetained: true,
    restoredGeneration: generation, newInputId: restoredInput, source: { sourceId: sourceA.sourceId, revision: sourceA.revision } });

  const beforeFreshInputs = inputs(), beforeFreshEffects = effects().length, beforeFreshJobs = cold.jobs.length;
  stage('cold-Claude-fresh-B');
  const fresh = await launchFresh();
  assert.equal(cold.jobs.length, 2);
  evidence.freshJobCount = cold.jobs.length;
  assert.notEqual(fresh.launchId, teamA.launchId);
  assert.notEqual(fresh.job.capability, restoredJob[0]!.capability);
  assert.equal(cold.jobs.length, beforeFreshJobs + 1);
  assert.equal(cold.jobs[beforeFreshJobs], fresh.job);
  const freshInitialized = effects().slice(beforeFreshEffects).filter(value =>
    value.event === 'initialized' && value.pid === fresh.entry.pid);
  assert.equal(freshInitialized.length, 1); assert.equal(freshInitialized[0]!.restored, false);
  const sessionId = freshInitialized[0]!.sessionId;
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0);
  assert.notEqual(sessionId, original.sessionId);
  assert.deepEqual(inputs(), beforeFreshInputs);
  const freshInput = await boot('TEST-fresh-B-new-input', fresh.generation);
  assert.notEqual(freshInput, inputA); assert.notEqual(freshInput, restoredInput);
  const afterFreshInputs = inputs();
  assert.equal(afterFreshInputs.length, beforeFreshInputs.length + 1);
  assert.deepEqual(afterFreshInputs.slice(0, beforeFreshInputs.length), beforeFreshInputs);
  const delivered = afterFreshInputs[beforeFreshInputs.length]!;
  assert.equal(delivered.pid, fresh.entry.pid); assert.equal(delivered.sessionId, sessionId);
  assert.equal(delivered.marker, 'TEST_UI_BOOT');
  assert.ok(typeof delivered.inputId === 'string' && delivered.inputId.length > 0);
  assert.equal(beforeFreshInputs.some(value => value.inputId === delivered.inputId), false);
  const freshStopped = await cold.rpc(0, 'runtime.stop', 'TEST-stop-fresh-B', {
    memberId: 'alice-id', expectedGeneration: fresh.generation });
  assert.equal(freshStopped.phase, 'closed'); assert.equal(freshStopped.custody, 'released');
  evidence.freshLaunch = { launchId: fresh.launchId, generation: fresh.generation,
    captureDigest: fresh.captureDigest, source: { sourceId: sourceB.sourceId, revision: sourceB.revision },
    inputId: freshInput, nativeReady: true, independentNativeSession: true, originalInputsReplayed: false,
    stopped: { phase: freshStopped.phase, custody: freshStopped.custody } };
}
