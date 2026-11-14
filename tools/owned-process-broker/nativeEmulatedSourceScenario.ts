/** TEST original Main source admission through Host/D and separately retained Windows Jobs. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { TeamOwnerStore } from '../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { readScheduledRunCapture } from '../../packages/legacy-agent-host/dist/composition/scheduledRunCapture.js';
import { runtimeCaptureSourceSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureProviderManagement } from '../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import { captureRuntimeSources } from '../../src/features/agent-backend/main/infrastructure/CapturedRuntimeSources';
import { captureMainWindowsCustody } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';
import { prepareMainWindowsRuntimeSource, prepareMainWindowsRuntimeSourceRecovery,
  prepareMainWindowsRuntimeConfiguration } from '../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';
import { capturedRuntimeSourceGrant } from '../../src/features/agent-backend/main/infrastructure/capturedRuntimeSourceGrant';
import { loadDesktopBackendDescriptor } from '../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import { capturedQueryableWitness } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { fileHash } from './nativeEmulatedProfile';
import { finiteSourceProbe, prepareEmulatedSourceProfile } from './nativeEmulatedSourceProfile';

import type { HostCustodyOwner, RuntimeSourceProcessOrigin } from '@agent-teams/legacy-agent-host/owned-process';
import type { RuntimeSourcePublishIntent, RuntimeSourceSummary } from '@agent-teams/legacy-agent-host/runtime-sources';
import type { JsonValue } from '../../packages/legacy-agent-host/dist/contracts.js';
import type { ScheduledRunInput } from '../../packages/legacy-agent-host/dist/composition/scheduledRunContracts.js';
import type { EmulatedSourceProvider } from './nativeEmulatedSourceProfile';

const object = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw)); return raw as Record<string, unknown>;
};
const json = (raw: unknown): JsonValue => JSON.parse(JSON.stringify(raw)) as JsonValue;
const text = (raw: unknown): string => { assert.equal(typeof raw, 'string'); return raw as string; };
const rows = (raw: unknown): Record<string, unknown>[] => { assert.ok(Array.isArray(raw)); return raw.map(object); };
const unwrap = (raw: unknown): Record<string, unknown> => {
  const reply = object(raw); assert.equal(reply.ok, true, `TEST original Host refused: ${String(reply.code)}`);
  return object(reply.value);
};
function journal(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
  const value = readFileSync(path, 'utf8'); if (!value) return [];
  assert.ok(value.endsWith('\n'));
  return value.trimEnd().split('\n').map(line => object(JSON.parse(line)));
}
async function poll(check: () => Promise<boolean>, message: string, budget = 15000): Promise<void> {
  const deadline = performance.now() + budget;
  for (;;) {
    if (await check()) return;
    assert.ok(performance.now() < deadline, message); await delay(25);
  }
}
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
interface Job {
  capability: string;
  origin?: RuntimeSourceProcessOrigin;
  root?: { pid: number; birth: string };
  witness?: Witness;
  resumed: boolean;
  stopped: boolean;
  drained: boolean;
  released: boolean;
  handleAbsent: boolean;
  threadEphemeral: boolean[];
  wire: string;
}

/** This receipt is populated before work, so an incomplete original stage remains visible on failure. */
export async function nativeEmulatedSourceScenario(sandbox: string, broker: string, actor: string,
  provider: EmulatedSourceProvider, sentinel: ChildProcess, evidence: Record<string, unknown>): Promise<void> {
  Object.assign(evidence, { provider, status: 'INCOMPLETE', stage: 'capture', cleanup: false,
    realProviderExecuted: false, desktopQualified: false, releaseQualified: false });
  const fixture = await prepareEmulatedSourceProfile(sandbox, broker, provider);
  const descriptor = await loadDesktopBackendDescriptor(fixture.descriptorSelection);
  const selected = descriptor.management![0]!, grant = capturedRuntimeSourceGrant(descriptor, selected);
  const events = createNativeGateEvents(), observedChildren: ChildProcess[] = [];
  const track = (child: ChildProcess) => observedChildren.push(child);
  const entries = () => journal(fixture.entries);
  const effects = () => {
    const values = journal(fixture.effects); assert.equal(values.some(value => value.event === 'failure'), false);
    return values;
  };
  const inputs = () => effects().filter(value => value.event === 'input');
  const sourceRef = (value: Pick<RuntimeSourceSummary, 'sourceId' | 'revision'>) => ({ sourceId: value.sourceId, revision: value.revision });
  const stage = (value: string) => { evidence.stage = value; console.log(JSON.stringify({ kind: 'TEST_SOURCE_STAGE', provider, stage: value })); };
  evidence.pins = fixture.pins; evidence.versions = fixture.versions;
  const open = () => {
    const physical = captureMainWindowsCustody(fixture.host, [grant]); assert.ok(physical);
    const jobs: Job[] = [], pending = { admitted: 0, revoked: 0 }, counts = { service: 0 };
    let available = true, foreground = true, closed = false;
    const observed: HostCustodyOwner = { mainEpoch: physical.mainEpoch,
      attach(context) {
        const original = physical.attach(context);
        return { ...original, async handle(call) {
          const result = await original.handle(call);
          if (call.operation === 'allocate') {
            assert.ok(jobs.length < 64 && !jobs.some(value => value.capability === call.capability));
            jobs.push({ capability: call.capability,
              ...(call.runtimeSourceOrigin ? { origin: structuredClone(call.runtimeSourceOrigin) } : {}),
              resumed: false, stopped: false, drained: false, released: false, handleAbsent: false, threadEphemeral: [], wire: '' });
          }
          const job = jobs.find(value => value.capability === call.capability); assert.ok(job);
          if (result.operation === 'prepare') {
            assert.equal(job.root, undefined); job.root = result.root;
            // Capture the original suspended root HANDLE before forwarding preparation to Host/resume.
            job.witness = await capturedQueryableWitness(actor, result.root.pid, result.root.birth, track, events);
          }
          if (result.operation === 'resume') job.resumed = true;
          if (result.operation === 'stop' && result.state === 'confirmed') job.stopped = true;
          if (result.operation === 'drain' && result.state === 'complete') job.drained = true;
          if (result.operation === 'release' && result.state === 'released') job.released = true;
          if (call.operation.startsWith('service-')) counts.service++;
          if (provider === 'codex' && call.operation === 'write') {
            job.wire += Buffer.from(call.bytes, 'base64').toString('utf8');
            assert.ok(Buffer.byteLength(job.wire) <= 131072);
            for (let end = job.wire.indexOf('\n'); end >= 0; end = job.wire.indexOf('\n')) {
              const line = job.wire.slice(0, end); job.wire = job.wire.slice(end + 1);
              const frame = object(JSON.parse(line));
              // Only the original ephemeral boolean is retained, never stdin prompts/MCP credentials.
              if (frame.method === 'thread/start') {
                const ephemeral = object(frame.params).ephemeral;
                assert.ok(ephemeral === undefined || typeof ephemeral === 'boolean');
                job.threadEphemeral.push(ephemeral === true);
              }
            }
          }
          return result;
        } };
      } };
    const client = new CapturedHostClient(fixture.host, observed);
    const current = () => available && foreground;
    const sources = captureRuntimeSources({ grant, client, start: () => client.start(),
      ownerAvailable: () => available, foregroundCurrent: () => foreground,
      prepareNativePublication(input) {
        const release = prepareMainWindowsRuntimeSource(physical, grant, input, current);
        pending.admitted++; return () => { release(); pending.revoked++; };
      },
      prepareNativeRecovery: () => prepareMainWindowsRuntimeSourceRecovery(physical, grant, current),
      prepareNativeConfiguration: input => prepareMainWindowsRuntimeConfiguration(physical, grant, input, current),
    });
    const rpc = async (team: number, method: string, commandId: string, payload: unknown) => unwrap(await client.request(method,
      json({ commandId, binding: { schemaVersion: 1, handleId: descriptor.handles[team]!.handleId,
        owner: fixture.profile.owner, scope: fixture.profile.teams[team]!.scope }, payload }),
      { control: method === 'runtime.read' || method === 'runtime.stop' || method.endsWith('.read') }));
    const management = (source: RuntimeSourceSummary) => captureProviderManagement({
      targetId: capturedRuntimeSourceGrant(descriptor, { ...selected, profileId: source.profileId,
        configRevision: source.configRevision }).targetId,
      profileId: source.profileId, configRevision: source.configRevision, client, start: () => client.start(),
      ownerAvailable: () => available, foregroundCurrent: () => foreground,
    });
    return { physical, client, jobs, pending, counts, sources, rpc, management,
      revokeForeground: () => { foreground = false; },
      async close() {
        if (closed) return;
        const failures: unknown[] = [];
        try { await client.shutdown(); } catch (error) { failures.push(error); }
        try { assert.equal(await physical.close(), true); } catch (error) { failures.push(error); }
        available = false;
        for (const job of jobs) {
          try {
            assert.ok(job.root && job.witness && job.resumed && job.stopped && job.drained && job.released,
              'Every original physical Job retains confirmed Stop/drain/release');
            assert.equal(await job.witness.wait(), 0);
            job.handleAbsent = true;
          } catch (error) { failures.push(error); }
        }
        assert.equal(counts.service, 0, 'Source metadata/probes/standalone do not register Team services');
        if (failures.length) throw new AggregateError(failures, 'TEST original source epoch cleanup incomplete');
        closed = true;
      },
    };
  };
  const epochs: ReturnType<typeof open>[] = [];
  const jobEntry = (job: Job, event: 'peer' | 'version') => {
    assert.ok(job.root);
    const values = entries().filter(value => value.event === event &&
      (value.pid === job.root!.pid || value.parentPid === job.root!.pid));
    assert.equal(values.length, 1, 'One pinned entry belongs to this original Job root');
    return values[0]!;
  };
  const assertSourceJobs = (jobs: Job[], source: RuntimeSourceSummary, image: 'A' | 'B',
    kind: 'management' | 'runtime', teamId?: string) => {
    assert.ok(jobs.length > 0);
    for (const job of jobs) {
      assert.ok(job.origin); assert.deepEqual(sourceRef(job.origin), sourceRef(source));
      assert.equal(job.origin.origin.kind, kind);
      if (kind === 'runtime') {
        assert.equal(job.origin.origin.kind, 'runtime');
        if (job.origin.origin.kind === 'runtime') {
          assert.equal(job.origin.origin.teamId, teamId); assert.equal(job.origin.origin.scope.teamId, teamId);
          assert.equal(job.origin.origin.projectPath, fixture.workspace);
        }
      } else if (job.origin.origin.kind === 'management') {
        assert.equal(job.origin.origin.profileId, source.profileId);
        assert.equal(job.origin.origin.configRevision, source.configRevision);
      }
      assert.equal(jobEntry(job, 'peer').source, image);
    }
  };
  const noTeamConnection = (jobs: Job[]) => {
    const pids = jobs.map(job => jobEntry(job, 'peer').pid);
    assert.equal(effects().some(value => pids.includes(value.pid) &&
      (value.event === 'connected' || value.event === 'mcp-connected')), false);
  };
  const quiescent = (jobs: Job[]) => jobs.every(job => job.stopped && job.drained && job.released);
  let failure: unknown, complete = false;
  try {
    const first = open(); epochs.push(first); await first.client.start();
    const captured = await first.sources.current(); assert.equal(captured.sourceKind, 'captured');
    const publish = async (image: 'A' | 'B', previous: RuntimeSourceSummary) => {
      const input: RuntimeSourcePublishIntent = { commandId: `TEST-publish-${image}`, expectedRevision: previous.revision,
        nativeSelection: { sourceKind: 'app-managed', nativeCli: {
          executable: { path: fixture.images[image].path, sha256: fixture.images[image].sha256 },
          version: fixture.versions[image], ...(provider === 'opencode' ? { generation: 'v1' as const } : {}),
        } } };
      const before = first.jobs.length, beforeEntries = entries().length, pending = { ...first.pending };
      const result = await first.sources.publish(input);
      assert.equal(result.phase, 'published'); assert.ok(result.selection);
      const jobs = first.jobs.slice(before), expected = image === 'B' && provider === 'claude' ? ['A', 'B'] : [image];
      assert.equal(jobs.length, expected.length); assert.ok(quiescent(jobs));
      assert.deepEqual(entries().slice(beforeEntries).map(value => [value.event, value.source]), expected.map(value => ['version', value]));
      for (const [index, job] of jobs.entries()) {
        assert.equal(job.origin, undefined); assert.equal(jobEntry(job, 'version').source, expected[index]);
        assert.equal(await job.witness!.wait(), 0);
        job.handleAbsent = true;
      }
      assert.deepEqual(first.pending, { admitted: pending.admitted + 1, revoked: pending.revoked + 1 });
      return { input, result, source: result.selection };
    };
    stage('publish-A'); const a = await publish('A', captured);
    const launch = async (team: number, source: RuntimeSourceSummary, image: 'A' | 'B') => {
      const roster = await first.rpc(team, 'team.roster.read', `TEST-roster-${image}`, {});
      await first.rpc(team, 'team.roster.replace', `TEST-save-${image}`, { expectedRevision: roster.revision,
        members: [], savedSettings: fixture.profile.teams[team]!.savedSettings });
      const capturedLaunch = await first.rpc(team, 'team.launch.capture', `TEST-capture-${image}`, { rosterCommandId: `TEST-save-${image}` });
      const selectedLaunch = object(capturedLaunch.launch), launchId = text(selectedLaunch.launchId);
      const store = new TeamOwnerStore(fixture.profile.owner.storageRoot, fixture.profile.teams[team]!.binding.teamName);
      const capturePath = join(store.directory, `launches/${runtimeDigest(launchId)}.json`);
      const record = object(JSON.parse(readFileSync(capturePath, 'utf8')));
      const canonical = runtimeCaptureSourceSchema.parse(object(record.definition).capture);
      assert.deepEqual(canonical.recipeSources, [{ memberId: 'alice-id', ...sourceRef(source) }]);
      const before = first.jobs.length;
      await first.rpc(team, 'team.launch.start', `TEST-start-${image}`, { launchId, rosterRevision: selectedLaunch.rosterRevision });
      let view: Record<string, unknown> = {};
      await poll(async () => { view = await first.rpc(team, 'runtime.read', `TEST-ready-${image}`, { memberId: 'alice-id' });
        return view.nativeReady === true; }, 'Original source Team readiness');
      const jobs = first.jobs.slice(before);
      assertSourceJobs(jobs, source, image, 'runtime', fixture.profile.teams[team]!.binding.teamId);
      const live = jobs.filter(job => !job.released); assert.equal(live.length, 1);
      const entry = jobEntry(live[0]!, 'peer');
      assert.equal(effects().filter(value => value.pid === entry.pid &&
        (value.event === 'connected' || value.event === 'mcp-connected')).length, 1);
      return { launchId, generation: text(view.generation), job: live[0]!, entry,
        capture: canonical, capturePath, captureDigest: runtimeDigest(canonical) };
    };
    const boot = async (epoch: ReturnType<typeof open>, team: number, commandId: string, generation: string) => {
      const sent = await epoch.rpc(team, 'team.execute', commandId, { operation: 'message.send',
        payload: { to: 'alice', text: 'TEST_UI_BOOT', messageId: commandId, actionMode: 'do' } });
      const inputId = text(object(sent.effects).deliveryId);
      await poll(async () => {
        const view = await epoch.rpc(team, 'runtime.read', `${commandId}-read`, { memberId: 'alice-id', expectedGeneration: generation });
        const input = rows(view.inputs).find(row => row.inputId === inputId);
        if (input?.phase !== 'terminal') return false;
        assert.equal(input.terminal, 'succeeded'); return true;
      }, 'Original source input terminal');
      return inputId;
    };
    stage('Team-A'); const teamA = await launch(0, a.source, 'A');
    const inputA = await boot(first, 0, 'TEST-boot-A', teamA.generation);
    const originalAInputs = inputs().filter(value => value.pid === teamA.entry.pid);
    assert.equal(originalAInputs.length, 1); assert.equal(originalAInputs[0]!.marker, 'TEST_UI_BOOT');
    assert.equal(await teamA.job.witness!.observe(), 'alive');
    stage('publish-B'); const b = await publish('B', a.source);
    assert.notEqual(a.source.revision, b.source.revision);
    assert.deepEqual(await first.sources.current(), b.source);
    assert.equal((await first.sources.retained()).filter(value => value.revision === a.source.revision).length, 1);
    assert.equal(await teamA.job.witness!.observe(), 'alive');
    assert.deepEqual(inputs().filter(value => value.pid === teamA.entry.pid), originalAInputs);
    assert.equal(runtimeDigest(runtimeCaptureSourceSchema.parse(object(object(JSON.parse(readFileSync(teamA.capturePath, 'utf8'))).definition).capture)), teamA.captureDigest);
    const beforeDenied = first.jobs.length;
    assert.throws(() => prepareMainWindowsRuntimeSource(first.physical,
      { ...grant, teamScopes: [{ ...grant.teamScopes[0]!, teamId: 'TEST-foreign-team' }] }, b.input, () => true));
    assert.equal(first.jobs.length, beforeDenied);
    evidence.foreignScopeGrantRefusedBeforeAllocation = true;
    stage('B-management'); const management = first.management(b.source), metadataBefore = first.jobs.length;
    const metadata = unwrap(await management.request(provider === 'codex' ? 'codex.metadata'
      : provider === 'claude' ? 'claude.metadata' : 'catalog', provider !== 'claude' ? { includeModels: true } : {}));
    assert.equal(metadata.profileId, b.source.profileId); assert.equal(metadata.configRevision, b.source.configRevision);
    if (provider === 'codex') assert.ok(rows(metadata.models).some(value => value.id === 'TEST-model'));
    else if (provider === 'claude') assert.ok(rows(metadata.models).some(value => value.modelId === 'sonnet' && value.resolvedModel === 'TEST-claude-sonnet'));
    else assert.ok(rows(metadata.providers).some(value => value.providerId === 'TEST-provider' &&
      rows(value.models).some(model => model.modelId === 'TEST-model')));
    const metadataJobs = first.jobs.slice(metadataBefore);
    assertSourceJobs(metadataJobs, b.source, 'B', 'management'); noTeamConnection(metadataJobs);
    if (provider === 'opencode') {
      assert.equal(metadataJobs.length, 1); assert.equal(metadataJobs[0]!.released, false);
      assert.equal(await metadataJobs[0]!.witness!.observe(), 'alive');
    } else assert.ok(quiescent(metadataJobs));
    stage('B-probe'); const probeBefore = first.jobs.length;
    const probeInputBefore = inputs().length;
    const probe = { commandId: 'TEST-source-probe-B', providerId: provider === 'opencode' ? 'TEST-provider' : fixture.providerId,
      modelId: fixture.model, ...(provider === 'claude' ? { effort: 'low' } : {}) };
    unwrap(await management.request('probe.start', probe));
    await poll(async () => {
      const value = unwrap(await management.request('probe.read', { commandId: probe.commandId }));
      if (value.phase !== 'completed') return false;
      assert.equal(value.ok, true); assert.equal(value.profileId, b.source.profileId); return true;
    }, 'Original B model probe', 30000);
    // Original V1 catalog retains its same management Host; probe retirement releases that Job.
    const probeJobs = [...(provider === 'opencode' ? metadataJobs : []), ...first.jobs.slice(probeBefore)];
    assertSourceJobs(probeJobs, b.source, 'B', 'management'); noTeamConnection(probeJobs);
    assert.ok(quiescent(probeJobs));
    const actualProbeInputs = inputs().slice(probeInputBefore);
    assert.equal(actualProbeInputs.length, 1); assert.equal(actualProbeInputs[0]!.marker, 'TEST_MODEL_PROBE');
    assert.ok(probeJobs.some(job => jobEntry(job, 'peer').pid === actualProbeInputs[0]!.pid));
    const probeInputs = inputs().length, probePhysical = first.jobs.length;
    assert.equal(unwrap(await management.request('probe.start', probe)).phase, 'completed');
    assert.equal(first.jobs.length, probePhysical); assert.equal(inputs().length, probeInputs);
    evidence.management = { source: sourceRef(b.source), metadataRead: true, modelProbeCompleted: true,
      modelProbeReplayAllocated: false, modelProbeInputs: 1, metadataHostRetained: provider === 'opencode' };
    stage('Team-B'); const teamB = await launch(1, b.source, 'B');
    const inputB = await boot(first, 1, 'TEST-boot-B', teamB.generation);
    assert.equal(await teamA.job.witness!.observe(), 'alive');
    assert.deepEqual(inputs().filter(value => value.pid === teamA.entry.pid), originalAInputs);
    let scheduled: ScheduledRunInput | undefined;
    if (provider !== 'opencode') {
      stage('B-standalone');
      const roster = await first.rpc(1, 'team.roster.read', 'TEST-schedule-roster', {});
      scheduled = { runId: 'TEST-source-standalone-B', scheduleId: 'TEST-source-schedule-B',
        expectedRosterRevision: text(roster.revision), config: { cwd: fixture.workspace,
          prompt: provider === 'claude' ? 'TEST_UI_STANDALONE_DONE' : finiteSourceProbe,
          providerId: provider === 'claude' ? 'anthropic' : 'codex', model: fixture.model, skipPermissions: true,
          ...(provider === 'claude' ? { effort: 'low', resolvedFastMode: false } : {}) },
        ...(provider === 'claude' ? { maxTurns: 6, maxBudgetUsd: 0.25 } : {}) };
      const before = first.jobs.length;
      await first.rpc(1, 'schedule.run.start', scheduled.runId, scheduled);
      let completed: Record<string, unknown> = {};
      await poll(async () => {
        completed = await first.rpc(1, 'schedule.run.read', 'TEST-schedule-read', { runId: scheduled!.runId, scheduleId: scheduled!.scheduleId });
        return completed.phase === 'completed';
      }, 'Original standalone completion');
      assert.equal(completed.cleanup, 'confirmed'); assert.equal(object(completed.result).exitCode, 0);
      assert.ok(text(object(completed.result).stdout).includes(provider === 'claude' ? 'TEST standalone complete' : 'OK'));
      const capture = readScheduledRunCapture(new TeamOwnerStore(fixture.profile.owner.storageRoot,
        fixture.profile.teams[1]!.binding.teamName), scheduled.runId);
      assert.ok(capture); assert.deepEqual(capture.input, scheduled); assert.deepEqual(capture.source, sourceRef(b.source));
      const jobs = first.jobs.slice(before); assertSourceJobs(jobs, b.source, 'B', 'runtime', fixture.profile.teams[1]!.binding.teamId);
      noTeamConnection(jobs); assert.ok(quiescent(jobs));
      if (provider === 'codex') assert.deepEqual(jobs.flatMap(job => job.threadEphemeral), [true]);
      const inputCount = inputs().length, jobCount = first.jobs.length;
      assert.equal((await first.rpc(1, 'schedule.run.start', scheduled.runId, scheduled)).phase, 'completed');
      assert.equal(inputs().length, inputCount); assert.equal(first.jobs.length, jobCount);
      evidence.standalone = { phase: 'completed', source: capture.source, inputDigest: runtimeDigest(capture.input),
        limits: provider === 'claude' ? { maxTurns: 6, maxBudgetUsd: 0.25 } : null, ephemeral: true, replayAllocated: false };
    } else evidence.standalone = { supported: false, reason: 'Original scheduledRunProfile rejects OpenCode' };
    let checkpoint: Record<string, unknown> | undefined;
    if (provider === 'claude') {
      stage('checkpoint-A');
      checkpoint = await first.rpc(0, 'runtime.checkpoint', 'TEST-checkpoint-A', {
        memberId: 'alice-id', expectedGeneration: teamA.generation, checkpointId: 'TEST-source-A-checkpoint' });
      assert.equal(checkpoint.status, 'published'); text(checkpoint.reference);
    }
    stage('retained-cleanup'); first.revokeForeground();
    await assert.rejects(first.sources.current());
    assert.ok((await first.sources.retained()).some(value => value.revision === a.source.revision));
    for (const [index, team] of [teamA, teamB].entries()) {
      const stopped = await first.rpc(index, 'runtime.stop', `TEST-stop-${index}`, { memberId: 'alice-id', expectedGeneration: team.generation });
      assert.equal(stopped.phase, 'closed'); assert.equal(stopped.custody, 'released');
    }
    await first.close(); assert.equal(sentinel.exitCode, null);
    const beforeColdInputs = inputs(), beforeColdEntries = entries();
    stage('cold-read-and-replay'); const cold = open(); epochs.push(cold); await cold.client.start();
    assert.deepEqual(await cold.sources.current(), b.source);
    assert.ok((await cold.sources.retained()).some(value => value.revision === a.source.revision));
    assert.deepEqual(await cold.sources.lookup(b.input.commandId), b.result);
    assert.deepEqual(cold.pending, { admitted: 0, revoked: 0 }); assert.equal(cold.jobs.length, 0);
    assert.deepEqual(await cold.sources.publish(b.input), b.result);
    assert.deepEqual(cold.pending, { admitted: 1, revoked: 1 }); assert.equal(cold.jobs.length, 0);
    const coldManagement = cold.management(b.source);
    assert.equal(unwrap(await coldManagement.request('probe.start', probe)).phase, 'completed');
    if (scheduled) {
      assert.equal((await cold.rpc(1, 'schedule.run.read', 'TEST-cold-schedule-read', { runId: scheduled.runId, scheduleId: scheduled.scheduleId })).phase, 'completed');
      assert.equal((await cold.rpc(1, 'schedule.run.start', scheduled.runId, scheduled)).phase, 'completed');
    }
    assert.equal(cold.jobs.length, 0); assert.deepEqual(inputs(), beforeColdInputs); assert.deepEqual(entries(), beforeColdEntries);
    evidence.cold = { currentB: true, retainedA: true, lookup: true, physicalReplayAllocations: 0,
      sourcePublishPendingAdmission: { ...cold.pending }, originalInputsReplayed: false, sdkPeerCheckpointRestored: false };
    if (checkpoint) {
      stage('cold-Claude-restore-A');
      const restoreInput = { memberId: 'alice-id', reference: checkpoint.reference, expectedGeneration: teamA.generation };
      const restored = await cold.rpc(0, 'runtime.restore', 'TEST-restore-A', restoreInput);
      assert.equal(restored.nativeReady, true); const generation = text(restored.generation);
      assert.notEqual(generation, teamA.generation);
      assertSourceJobs(cold.jobs, a.source, 'A', 'runtime', fixture.profile.teams[0]!.binding.teamId);
      const original = effects().find(value => value.event === 'initialized' && value.pid === teamA.entry.pid); assert.ok(original);
      const restoredJob = cold.jobs.filter(job => !job.released); assert.equal(restoredJob.length, 1);
      const restoredEntry = jobEntry(restoredJob[0]!, 'peer');
      const initialized = effects().filter(value => value.event === 'initialized' && value.pid === restoredEntry.pid);
      assert.equal(initialized.length, 1); assert.equal(initialized[0]!.restored, true);
      assert.equal(initialized[0]!.sessionId, original.sessionId); assert.deepEqual(inputs(), beforeColdInputs);
      const restoredJobs = cold.jobs.length, restoredEntries = entries();
      assert.deepEqual(await cold.sources.current(), b.source);
      assert.deepEqual(await cold.rpc(0, 'runtime.restore', 'TEST-restore-A', restoreInput), restored);
      assert.equal(cold.jobs.length, restoredJobs); assert.deepEqual(entries(), restoredEntries);
      assert.deepEqual(inputs(), beforeColdInputs);
      const restoredInput = await boot(cold, 0, 'TEST-restored-A-new-input', generation);
      assert.equal(inputs().length, beforeColdInputs.length + 1);
      const stopped = await cold.rpc(0, 'runtime.stop', 'TEST-stop-restored-A', { memberId: 'alice-id', expectedGeneration: generation });
      assert.equal(stopped.phase, 'closed'); assert.equal(stopped.custody, 'released');
      Object.assign(object(evidence.cold), { sdkPeerCheckpointRestored: true, originalNativeSessionRetained: true,
        restoredGeneration: generation, newInputId: restoredInput, source: sourceRef(a.source) });
    }
    await cold.close();
    evidence.selections = { A: a.source, B: b.source };
    evidence.teams = [{ launchId: teamA.launchId, generation: teamA.generation, inputId: inputA, captureDigest: teamA.captureDigest, source: sourceRef(a.source) },
      { launchId: teamB.launchId, generation: teamB.generation, inputId: inputB, captureDigest: teamB.captureDigest, source: sourceRef(b.source) }];
    assert.equal(sentinel.exitCode, null); complete = true;
  } catch (error) { failure = error; }
  finally {
    const errors: unknown[] = [];
    for (const epoch of epochs) try { await epoch.close(); } catch (error) { errors.push(error); }
    try { effects(); for (const pin of fixture.pins) assert.equal(fileHash(pin.path), pin.sha256); }
    catch (error) { errors.push(error); }
    evidence.epochs = epochs.map(epoch => ({ mainEpoch: epoch.physical.mainEpoch, pending: epoch.pending,
      serviceOperations: epoch.counts.service, jobs: epoch.jobs.map(job => ({ capability: job.capability,
        origin: job.origin ?? null, root: job.root ?? null, resumed: job.resumed, stopped: job.stopped,
        drained: job.drained, released: job.released, originalHandleAbsent: job.handleAbsent,
        threadEphemeral: job.threadEphemeral })) }));
    evidence.cleanup = errors.length === 0;
    // Original Job/HANDLE cleanup above is mandatory; these are only gate-owned observer children.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'TEST source scenario cleanup incomplete');
  }
  if (failure) throw failure;
  assert.ok(complete && evidence.cleanup === true); evidence.status = 'PASS'; evidence.stage = 'complete';
}
