/** TEST original Main source admission through Host/D and separately retained Windows Jobs. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { TeamOwnerStore } from '../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { readScheduledRunCapture } from '../../packages/legacy-agent-host/dist/composition/scheduledRunCapture.js';
import { runtimeCaptureSourceSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js';
import { resolveRuntimeRecipe } from '../../packages/legacy-agent-host/dist/composition/runtimeRecipe.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { BackendOwnerRouter } from '../../src/features/agent-backend/main/application/BackendOwnerRouter';
import { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { captureLocalModelReadinessOrigin, captureRequestReadinessBudget, createReadinessPreparation,
  readCapturedLaunchReadiness } from '../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import { FileHandleBindingStore } from '../../src/features/agent-backend/main/infrastructure/FileHandleBindingStore';
import { JsonLocalProviderPrivateNetworkApprovalStore } from '../../src/features/runtime-provider-management/main/readiness';
import { parseOpenCodeQualifiedModelRef } from '../../src/shared/utils/opencodeModelRef';
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
import { readEmulatedSourceActionProbe, observeEmulatedSourcePeerReadiness } from './nativeEmulatedSourceReadiness';

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
async function poll(check: () => Promise<boolean>, message: string, budget = 15000, absoluteDeadline?: number): Promise<void> {
  const deadline = absoluteDeadline ?? performance.now() + budget;
  for (;;) {
    assert.ok(performance.now() < deadline, message);
    const ready = await check();
    assert.ok(performance.now() < deadline, message);
    if (ready) return;
    await delay(25);
  }
}
function validateSourceRefusal(value: Record<string, unknown>, persisted: boolean) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  assert.ok(Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => 'value' in row));
  const hash = (raw: unknown) => typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw), clock = (raw: unknown) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
  const fields: Record<string, string> = { native: 'capability phase reason dispatched staged rootCaptured deadlineExpired',
    consumer: 'actionDigest groupDigest bindingDigest consumerId phase reason cutoff observedAt currentCalls',
    'opencode-open': 'bindingDigest phase reason',
    reference: 'commandDigest contextDigest phase reason probeCutoff probeNow scopeCutoff scopeNow preparationCutoff preparationNow', limit: '' };
  assert.ok(typeof value.kind === 'string' && Object.hasOwn(fields, value.kind));
  const keys = fields[value.kind]; assert.ok(typeof keys === 'string'); assert.deepEqual(Object.keys(value).sort(), ['kind', ...keys.split(' ').filter(Boolean), ...(persisted ? ['ordinal'] : [])].sort());
  if (persisted) assert.ok(typeof value.ordinal === 'number' && Number.isInteger(value.ordinal) && value.ordinal >= 1 && value.ordinal <= 65); if (value.kind === 'limit') { assert.equal(persisted, true); return; }
  assert.ok(typeof value.phase === 'string' && typeof value.reason === 'string');
  if (value.kind === 'native') {
    assert.ok(typeof value.capability === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.capability));
    assert.ok('capture staging allocate launch-chunk launch-commit post-commit prepare post-prepare resume'.split(' ').includes(value.phase));
    assert.ok('sealed current-false current-threw launch-deadline refused unknown result-mismatch preparation-failed'.split(' ').includes(value.reason));
    assert.ok(['dispatched', 'staged', 'rootCaptured'].every(key => typeof value[key] === 'boolean'));
    assert.equal(value.deadlineExpired, value.reason === 'launch-deadline' ? true : null);
  } else if (value.kind === 'opencode-open') {
    assert.ok(hash(value.bindingDigest)); assert.equal(value.reason, 'threw');
    assert.ok('configuration server-launch native-ready startup-authority startup-configuration startup-delay session-authority session-create driver-readiness'.split(' ').includes(value.phase));
  } else {
    assert.ok(value.reason === 'held' || value.reason === 'threw'); const consumer = value.kind === 'consumer';
    if (consumer) {
      const timing = object(value.currentCalls);
      assert.ok(timing && typeof timing === 'object' && !Array.isArray(timing) && [Object.prototype, null].includes(Object.getPrototypeOf(timing)));
      assert.ok(Object.getOwnPropertySymbols(timing).length === 0 && Object.values(Object.getOwnPropertyDescriptors(timing)).every(row => 'value' in row));
      assert.deepEqual(Object.keys(timing).sort(), ['count', 'lastMs', 'maxMs', 'totalMs', 'truncated', ...(Object.hasOwn(timing, 'regions') ? ['regions'] : [])].sort());
      assert.ok(clock(timing.count) && (timing.count as number) <= 4096 && clock(timing.totalMs) && clock(timing.maxMs) && (timing.maxMs as number) <= (timing.totalMs as number));
      assert.equal(typeof timing.truncated, 'boolean');
      assert.ok(timing.lastMs === null || clock(timing.lastMs) && (timing.lastMs as number) <= (timing.maxMs as number));
      if (timing.count === 0) assert.ok(timing.totalMs === 0 && timing.maxMs === 0 && timing.lastMs === null);
      else if (!timing.truncated) assert.notEqual(timing.lastMs, null);
      if (Object.hasOwn(timing, 'regions')) {
        const regions = object(timing.regions);
        assert.ok(regions && typeof regions === 'object' && !Array.isArray(regions) && [Object.prototype, null].includes(Object.getPrototypeOf(regions)));
        assert.ok(Object.getOwnPropertySymbols(regions).length === 0 && Object.values(Object.getOwnPropertyDescriptors(regions)).every(row => 'value' in row));
        const names = ['initialAuthority', 'readConsumer', 'reference', 'finalAuthority', ...(Object.hasOwn(regions, 'referenceAccountCount') ? ['referenceAccount', 'referenceAccountAuthority'] : [])];
        assert.deepEqual(Object.keys(regions).sort(), names.flatMap(name => [name + 'Count', name + 'Ms']).sort());
        for (const name of names) {
          const count = regions[name + 'Count'], milliseconds = regions[name + 'Ms'];
          assert.ok(clock(count) && (count as number) <= (timing.count as number) && clock(milliseconds) && (count !== 0 || milliseconds === 0));
        }
      }
    }
    assert.ok((consumer ? ['actionDigest', 'groupDigest', 'bindingDigest', 'consumerId'] : ['commandDigest', 'contextDigest']).every(key => hash(value[key])));
    assert.ok((consumer ? 'initial-authority read-consumer identity continuation requirements cutoff reference equality final-authority' :
      'read inspect admission target scope retired completion probe-expiry scope-cutoff preparation-expiry origin purpose readiness account projection').split(' ').includes(value.phase));
    for (const [cutoff, now] of (consumer ? [['cutoff', 'observedAt']] : [['probeCutoff', 'probeNow'], ['scopeCutoff', 'scopeNow'], ['preparationCutoff', 'preparationNow']]) as [string, string][])
      assert.ok(value[cutoff] === null ? value[now] === null : clock(value[cutoff]) && clock(value[now]));
  }
}

type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
type CustodyPhase = 'allocate' | 'prepare' | 'resume' | 'stop' | 'drain' | 'release';
type StagingPhase = 'launch-chunk' | 'launch-commit';
interface CustodyTiming {
  calls: number;
  settled: number;
  returned: number;
  totalMs: number;
  firstStartMs: number | null;
  lastEndMs: number | null;
}
const custodyTiming = (): CustodyTiming => ({
  calls: 0, settled: 0, returned: 0, totalMs: 0, firstStartMs: null, lastEndMs: null,
});
const custodyTimings = (): Record<CustodyPhase, CustodyTiming> => ({
  allocate: custodyTiming(), prepare: custodyTiming(), resume: custodyTiming(),
  stop: custodyTiming(), drain: custodyTiming(), release: custodyTiming(),
});
const stagingTimings = (): Record<StagingPhase, CustodyTiming> => ({
  'launch-chunk': custodyTiming(), 'launch-commit': custodyTiming(),
});
interface Job {
  capability: string;
  timings: Record<CustodyPhase, CustodyTiming>;
  stagingTimings: Record<StagingPhase, CustodyTiming>;
  origin?: RuntimeSourceProcessOrigin;
  root?: { pid: number; birth: string };
  witness?: Witness;
  entryStart?: number;
  entryEnd?: number;
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
  if (provider === 'opencode') {
    const configuration = text(fixture.profile.runtime!.members[0]!.environment?.OPENCODE_CONFIG_CONTENT);
    const path = join(fixture.workspace, 'opencode.json');
    writeFileSync(path, configuration, { mode: 0o600, flag: 'wx' });
    fixture.pins.push({ path, sha256: fileHash(path) });
  }
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
  const diagnosticLaunches: { actionDigest: string; bindingDigests: string[]; launchId: string; source: ReturnType<typeof sourceRef> }[] = [];
  const open = () => {
    const physical = captureMainWindowsCustody(fixture.host, [grant]); assert.ok(physical);
    const jobs: Job[] = [], pending = { admitted: 0, revoked: 0 }, counts = { service: 0 };
    const phaseClock = performance.now();
    let firstCloseEntryMs: number | null = null;
    let projectionHostExit: 'confirmed' | 'unknown' | null = null;
    let available = true, foreground = true, closed = false;
    const observed: HostCustodyOwner = { mainEpoch: physical.mainEpoch,
      attach(context) {
        const original = physical.attach(context);
        return { ...original, async handle(call) {
          const preparation = call.operation === 'prepare'
            ? { phase: 'owner' as 'owner' | 'witness' | 'complete', started: performance.now() } : undefined;
          const phase = call.operation === 'allocate' || call.operation === 'prepare' ||
            call.operation === 'resume' || call.operation === 'stop' || call.operation === 'drain' ||
            call.operation === 'release' ? call.operation : undefined;
          const timings = phase === 'allocate' ? custodyTimings()
            : phase ? jobs.find(job => job.capability === call.capability)?.timings : undefined;
          const stagingPhase = call.operation === 'launch-chunk' || call.operation === 'launch-commit'
            ? call.operation : undefined;
          const timing = phase ? timings?.[phase] : stagingPhase
            ? jobs.find(job => job.capability === call.capability)?.stagingTimings[stagingPhase] : undefined;
          const phaseStarted = timing ? performance.now() : undefined;
          if (timing && phaseStarted !== undefined) {
            timing.calls++; timing.firstStartMs ??= phaseStarted - phaseClock;
          }
          try {
            let result: Awaited<ReturnType<typeof original.handle>>;
            try {
              result = await original.handle(call);
              if (timing) timing.returned++;
            } finally {
              if (timing && phaseStarted !== undefined) {
                const ended = performance.now();
                timing.settled++; timing.totalMs += ended - phaseStarted;
                timing.lastEndMs = ended - phaseClock;
              }
            }
            if (call.operation === 'allocate') {
              assert.ok(jobs.length < 64 && !jobs.some(value => value.capability === call.capability));
              jobs.push({ capability: call.capability, timings: timings!, stagingTimings: stagingTimings(),
                ...(call.runtimeSourceOrigin ? { origin: structuredClone(call.runtimeSourceOrigin) } : {}),
                resumed: false, stopped: false, drained: false, released: false, handleAbsent: false, threadEphemeral: [], wire: '' });
            }
            const job = jobs.find(value => value.capability === call.capability); assert.ok(job);
            if (result.operation === 'prepare') {
              assert.equal(job.root, undefined); job.root = result.root;
              if (preparation) preparation.phase = 'witness';
              // Capture the original suspended root HANDLE before forwarding preparation to Host/resume.
              job.witness = await capturedQueryableWitness(actor, result.root.pid, result.root.birth, track, events,
                'query-wait-gated');
              job.entryStart = entries().length;
              if (preparation) preparation.phase = 'complete';
            }
            if (result.operation === 'resume') job.resumed = true;
            if (result.operation === 'stop' && result.state === 'confirmed') job.stopped = true;
            if (result.operation === 'drain' && result.state === 'complete') job.drained = true;
            if (result.operation === 'release' && result.state === 'released') {
              job.released = true;
              if (job.root && job.witness && job.entryStart !== undefined && !job.handleAbsent)
                job.entryEnd ??= entries().length;
            }
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
          } finally {
            if (preparation) {
              const jobSlot = jobs.findIndex(job => job.capability === call.capability), job = jobs[jobSlot];
              console.log(JSON.stringify({ kind: 'TEST_SOURCE_PREPARATION', provider, mainEpoch: physical.mainEpoch,
                jobSlot, phase: preparation.phase, elapsedMs: performance.now() - preparation.started,
                source: job?.origin ? sourceRef(job.origin) : null,
                rootCaptured: job?.root !== undefined, witnessCaptured: job?.witness !== undefined }));
            }
          }
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
    return { physical, client, jobs, pending, counts, sources, rpc, management, current,
      get firstCloseEntryMs() { return firstCloseEntryMs; },
      get projectionHostExit() { return projectionHostExit; },
      revokeForeground: () => { foreground = false; },
      async close() {
        firstCloseEntryMs ??= performance.now() - phaseClock;
        if (closed) return;
        const failures: unknown[] = [];
        try { projectionHostExit = (await client.shutdown()).childExit; } catch (error) { failures.push(error); }
        try { assert.equal(await physical.close(), true); } catch (error) { failures.push(error); }
        available = false;
        for (const [jobSlot, job] of jobs.entries()) {
          try {
            console.log(JSON.stringify({ kind: 'TEST_SOURCE_CLEANUP', provider, mainEpoch: physical.mainEpoch,
              jobSlot, source: job.origin ? sourceRef(job.origin) : null,
              rootCaptured: job.root !== undefined, witnessCaptured: job.witness !== undefined,
              resumed: job.resumed, stopped: job.stopped, drained: job.drained, released: job.released,
              originalHandleAbsent: job.handleAbsent, custodyTimings: job.timings,
              stagingTimings: job.stagingTimings, firstCloseEntryMs }));
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
    assert.ok(job.root && job.witness && job.entryStart !== undefined && !job.handleAbsent &&
      (!job.released || job.entryEnd !== undefined));
    const all = entries(), start = job.entryStart, end = job.entryEnd ?? all.length;
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      0 <= start && start <= end && end <= all.length);
    const values = all.slice(start, end).filter(value => value.event === event &&
      (value.pid === job.root!.pid || value.parentPid === job.root!.pid));
    if (values.length !== 1 && evidence.entryMatchFailure === undefined) {
      const processId = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
      evidence.entryMatchFailure = {
        event,
        root: { pid: job.root.pid, birth: job.root.birth },
        entryStart: job.entryStart ?? null, entryEnd: job.entryEnd ?? null,
        matchCount: values.length,
        matches: values.slice(0, 8).map(value => ({
          event,
          source: value.source === 'A' || value.source === 'B' ? value.source : null,
          role: value.role === 'runtime' || value.role === 'management' ? value.role : null,
          pid: processId(value.pid),
          parentPid: processId(value.parentPid),
        })),
        truncated: values.length > 8,
      };
    }
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
        // Physical custody retains the original management namespace; the outer reference selects A/B.
        assert.equal(job.origin.origin.profileId, selected.profileId);
        assert.equal(job.origin.origin.configRevision, selected.configRevision);
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
  let failure: unknown, complete = false, lastRuntimeViewDigest: string | undefined;
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
      const capturedDefinition = object(record.definition);
      const canonical = runtimeCaptureSourceSchema.parse(capturedDefinition.capture);
      assert.deepEqual(canonical.recipeSources, [{ memberId: 'alice-id', ...sourceRef(source) }]);
      const before = first.jobs.length, inputsBefore = inputs().length;
      const commandId = `TEST-start-${image}`, payload = { launchId, rosterRevision: text(selectedLaunch.rosterRevision) };
      diagnosticLaunches.push({ actionDigest: runtimeDigest(commandId), bindingDigests: rows(capturedDefinition.members).map(member => managementDigest(object(member.binding))), launchId, source: sourceRef(source) });
      let memberReadinessDeadline: number | undefined;
      if (provider !== 'claude') {
        assert.equal(capturedDefinition.launchId, payload.launchId);
        assert.equal(capturedDefinition.rosterRevision, payload.rosterRevision);
        assert.equal(record.startCommandId, undefined);
        const members = rows(capturedDefinition.members).filter(member => member.memberId === 'alice-id');
        const selected = rows(selectedLaunch.members).filter(member => member.memberId === 'alice-id');
        assert.equal(members.length, 1); assert.equal(selected.length, 1);
        const member = members[0]!, binding = object(member.binding);
        assert.deepEqual(binding, selected[0]!.binding);
        assert.equal(binding.backendId, fixture.profile.owner.ownerId);
        assert.equal(binding.teamId, fixture.profile.teams[team]!.binding.teamId);
        assert.equal(binding.runId, launchId); assert.equal(binding.memberId, 'alice-id');
        assert.equal(object(selected[0]!.attempt).claimed, false);
        const timeoutMs = member.timeoutMs;
        assert.ok(typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
      }
      if (provider === 'opencode') {
        // Reuse the original Main aggregate phases with this fixture's private native inputs.
        const budget = captureRequestReadinessBudget(fixture.host.requestTimeoutMs);
        const definition = fixture.profile.teams[team]!, selectedHandle = descriptor.handles[team]!;
        const bindingRoot = join(fixture.root, 'TEST-source-main-bindings');
        await mkdir(bindingRoot, { recursive: true, mode: 0o700 });
        const router = new BackendOwnerRouter(new FileHandleBindingStore(bindingRoot));
        router.registerOwner({ ...fixture.profile.owner, client: first.client, nativeCustody: first.physical });
        const handle = await router.createHandle(selectedHandle.handleId, definition.scope, selectedHandle.owner);
        assert.deepEqual(router.ownerBinding(selectedHandle.owner), fixture.profile.owner);
        const guard = { isCurrent: first.current };
        const read = await readCapturedLaunchReadiness({ router, handle, definition: selectedHandle,
          commandId, ...payload, guard, budget, capture: true });
        assert.equal(read.capture, null, 'Only the original Host read can establish this initial branch');
        assert.equal(read.view.launch.admission, undefined);
        assert.equal(read.view.launch.members.length, 1);
        assert.equal(read.view.launch.members[0]!.memberId, 'alice-id');
        assert.equal(read.view.launch.members[0]!.status, 'not-started');
        assert.equal(read.view.members.length, 1);
        const selected = read.view.members[0]!;
        assert.equal(selected.memberId, 'alice-id');
        assert.ok(selected.selected && selected.selected.provider === 'opencode');
        assert.equal(selected.selected.workspace, fixture.workspace);
        assert.equal(selected.selected.model, fixture.model);
        assert.equal(selected.selected.effort, undefined);
        const seed = fixture.profile.runtime!.members.find(member => member.teamId === definition.binding.teamId);
        assert.ok(seed && seed.provider === 'opencode' && seed.environment.HOME);
        const current = () => { assert.ok(first.current(), 'Original source Main owner remains current'); };
        const origin = await captureLocalModelReadinessOrigin({
          kind: 'team', owner: router.ownerBinding(selectedHandle.owner), contextId: selectedHandle.contextId,
          commandId, selection: { handleId: handle.handleId, scope: definition.scope, payload },
          workspaces: [fixture.workspace], targets: [{ workspace: fixture.workspace,
            providerId: parseOpenCodeQualifiedModelRef(selected.selected.model)?.sourceId ?? null }],
          current, budget, home: seed.environment.HOME, environment: { ...seed.environment },
          readApprovals: new JsonLocalProviderPrivateNetworkApprovalStore(
            join(fixture.root, 'TEST-private-network-approvals.json')).capture(),
        });
        unwrap(await router.request(handle, { commandId, method: 'team.launch.start', payload,
          guard, requestBudget: budget, localModelReadinessOrigin: createReadinessPreparation(origin, budget) }));
      } else await first.rpc(team, 'team.launch.start', commandId, payload);
      // Original readiness observation starts once after the Start acknowledgement.
      if (provider !== 'claude') memberReadinessDeadline = performance.now() + 15000;
      let view: Record<string, unknown> = {};
      const readiness = { source: sourceRef(source), image, launchId, readCount: 0, elapsedMs: 0,
        lastRuntimeRead: null as Record<string, unknown> | null };
      evidence.lastLaunchReadiness = readiness;
      const readinessStarted = performance.now();
      try {
        await poll(async () => { view = await first.rpc(team, 'runtime.read', `TEST-ready-${image}`, { memberId: 'alice-id' });
          try { lastRuntimeViewDigest = runtimeDigest(view); } catch { lastRuntimeViewDigest = undefined; }
          Object.assign(readiness, { readCount: readiness.readCount + 1, elapsedMs: performance.now() - readinessStarted,
            lastRuntimeRead: { viewDigest: lastRuntimeViewDigest ?? null, memberId: view.memberId, generation: view.generation, phase: view.phase,
              sealed: view.sealed, custody: view.custody, nativeReady: view.nativeReady, attached: view.attached,
              ...(view.diagnostic === undefined ? {} : { diagnostic: view.diagnostic }) } });
          return view.nativeReady === true; }, 'Original source Team readiness',
          undefined, memberReadinessDeadline);
      } finally {
        console.log(JSON.stringify({ kind: 'TEST_SOURCE_READINESS', provider, ...readiness }));
      }
      const jobs = first.jobs.slice(before);
      assertSourceJobs(jobs, source, image, 'runtime', fixture.profile.teams[team]!.binding.teamId);
      const live = jobs.filter(job => !job.released); assert.equal(live.length, 1);
      if (provider === 'opencode') {
        const probes = jobs.filter(job => job.released);
        assert.equal(jobs.length, 2); assert.equal(probes.length, 1);
        noTeamConnection(probes); assert.ok(quiescent(probes));
        const probeEntry = jobEntry(probes[0]!, 'peer');
        assert.equal(probeEntry.role, 'runtime');
        const actualInputs = inputs().slice(inputsBefore);
        assert.equal(actualInputs.length, 1);
        assert.equal(actualInputs[0]!.pid, probeEntry.pid);
        assert.equal(actualInputs[0]!.marker, 'TEST_MODEL_PROBE');
        assert.equal(effects().filter(row => row.pid === probeEntry.pid && row.event === 'terminal' &&
          row.marker === 'TEST_MODEL_PROBE' && row.outcome === 'succeeded').length, 1);
        const receipt = readEmulatedSourceActionProbe({ profile: fixture.profile, team,
          handleId: descriptor.handles[team]!.handleId, contextId: descriptor.handles[team]!.contextId,
          commandId, payload, fingerprint: text(record.fingerprint), captureDigest: runtimeDigest(canonical) });
        const replayJobs = first.jobs.length, replayInputs = inputs();
        await first.rpc(team, 'team.launch.start', commandId, payload);
        assert.equal(first.jobs.length, replayJobs); assert.deepEqual(inputs(), replayInputs);
        if (evidence.modelPreparations === undefined) evidence.modelPreparations = [];
        assert.ok(Array.isArray(evidence.modelPreparations));
        evidence.modelPreparations.push({ source: sourceRef(source), image, startCommandId: commandId,
          commandId: receipt.commandId, profileId: receipt.profileId, configRevision: receipt.configRevision,
          noTeamConnection: true, originalProbeInputs: 1, replayAllocated: false });
      }
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
    else assert.ok(rows(metadata.providers).some(value => value.providerId === 'test-provider' &&
      rows(value.models).some(model => model.modelId === 'TEST-model')));
    const metadataJobs = first.jobs.slice(metadataBefore);
    assertSourceJobs(metadataJobs, b.source, 'B', 'management'); noTeamConnection(metadataJobs);
    if (provider === 'opencode') {
      assert.equal(metadataJobs.length, 1); assert.equal(metadataJobs[0]!.released, false);
      assert.equal(await metadataJobs[0]!.witness!.observe(), 'alive');
    } else assert.ok(quiescent(metadataJobs));
    stage('B-probe'); const probeBefore = first.jobs.length;
    const probeInputBefore = inputs().length;
    const probe = { commandId: 'TEST-source-probe-B', providerId: provider === 'opencode' ? 'test-provider' : fixture.providerId,
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
      const standaloneStarted = performance.now();
      let standaloneDeadline: number | undefined;
      if (provider === 'codex') {
        const budgetCapture = readScheduledRunCapture(new TeamOwnerStore(fixture.profile.owner.storageRoot,
          fixture.profile.teams[1]!.binding.teamName), scheduled.runId);
        assert.ok(budgetCapture); assert.deepEqual(budgetCapture.input, scheduled); assert.deepEqual(budgetCapture.source, sourceRef(b.source));
        assert.equal(budgetCapture.memberId, 'alice-id');
        assert.equal(budgetCapture.teamScope, runtimeDigest(fixture.profile.teams[1]!.scope));
        const recipe = resolveRuntimeRecipe(fixture.profile.runtime, fixture.profile.teams[1]!.binding.teamId,
          budgetCapture.memberId, scheduled.config.providerId);
        assert.equal(runtimeDigest(recipe), budgetCapture.recipeDigest);
        // The original post-ACK observation includes these captured-source checks.
        standaloneDeadline = standaloneStarted + 15000;
      }
      let completed: Record<string, unknown> = {};
      const completion = { source: sourceRef(b.source), runId: scheduled.runId, scheduleId: scheduled.scheduleId,
        readCount: 0, elapsedMs: 0, lastRunRead: null as Record<string, unknown> | null };
      evidence.lastStandaloneCompletion = completion;
      const completionStarted = performance.now();
      try {
        await poll(async () => {
          completed = await first.rpc(1, 'schedule.run.read', 'TEST-schedule-read', { runId: scheduled!.runId, scheduleId: scheduled!.scheduleId });
          const result = completed.result;
          Object.assign(completion, { readCount: completion.readCount + 1, elapsedMs: performance.now() - completionStarted,
            lastRunRead: { phase: completed.phase, cleanup: completed.cleanup,
              ...(result && typeof result === 'object' && !Array.isArray(result)
                ? { exitCode: (result as Record<string, unknown>).exitCode } : {}) } });
          return completed.phase === 'completed';
        }, 'Original standalone completion',
        undefined, standaloneDeadline);
      } finally {
        console.log(JSON.stringify({ kind: 'TEST_SOURCE_STANDALONE', provider, ...completion }));
      }
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
    try { observeEmulatedSourcePeerReadiness(evidence, effects(), provider); for (const pin of fixture.pins) assert.equal(fileHash(pin.path), pin.sha256); }
    catch (error) { errors.push(error); }
    evidence.epochs = epochs.map(epoch => ({ mainEpoch: epoch.physical.mainEpoch, pending: epoch.pending,
      serviceOperations: epoch.counts.service, firstCloseEntryMs: epoch.firstCloseEntryMs,
      jobs: epoch.jobs.map(job => ({ capability: job.capability, stagingTimings: job.stagingTimings,
        origin: job.origin ?? null, root: job.root ?? null, resumed: job.resumed, stopped: job.stopped,
        drained: job.drained, released: job.released, originalHandleAbsent: job.handleAbsent,
        entryStart: job.entryStart ?? null, entryEnd: job.entryEnd ?? null,
        threadEphemeral: job.threadEphemeral })) }));
    evidence.cleanup = errors.length === 0;
    // Original Job/HANDLE cleanup above is mandatory; these are only gate-owned observer children.
    for (const child of observedChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'TEST source scenario cleanup incomplete');
    // TEST_RUNTIME_PROJECTION_READER_BEGIN
    if (failure) try {
      assert.equal(epochs.length, 1);
      assert.equal(epochs[0]?.projectionHostExit, 'confirmed');
      const stat = lstatSync(fixture.runtimeProjectionLedger);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512);
      const raw = readFileSync(fixture.runtimeProjectionLedger, 'utf8'); assert.ok(Buffer.byteLength(raw) <= 512);
      const ledger = object(JSON.parse(raw)); assert.deepEqual(Object.keys(ledger).sort(), ['rows', 'status']);
      assert.equal(ledger.status, 'observed'); assert.ok(Array.isArray(ledger.rows) && ledger.rows.length <= 4);
      const digests = new Set<string>();
      const records = ledger.rows.map((tuple: unknown) => {
        assert.ok(Array.isArray(tuple) && tuple.length === 6);
        const digest = text(tuple[0]); assert.match(digest, /^[a-f0-9]{64}$/); assert.equal(digests.has(digest), false); digests.add(digest);
        assert.equal(typeof tuple[1], 'boolean'); assert.equal(typeof tuple[5], 'boolean');
        for (let index = 2; index <= 4; index++)
          assert.ok(tuple.slice(1, index).every(value => value === true) ? typeof tuple[index] === 'boolean' : tuple[index] === null);
        assert.equal(tuple[5], tuple.slice(1, 5).every(value => value === true));
        return { viewDigest: digest, bindingMatches: tuple[1], recordReady: tuple[2],
          providerReady: tuple[3], ownerCurrent: tuple[4], nativeReady: tuple[5] };
      });
      const matches = records.filter(row => row.viewDigest === lastRuntimeViewDigest); assert.equal(matches.length, 1);
      evidence.runtimeProjection = { status: 'observed', atomicWithFailure: false, ...matches[0] };
    } catch { evidence.runtimeProjection = { status: 'unknown', reason: 'missing-invalid-overflow-conflicting-or-unjoined' }; }
    // TEST_RUNTIME_PROJECTION_READER_END
    if (failure) try {
      const stat = lstatSync(fixture.refusals); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
      const raw = readFileSync(fixture.refusals, 'utf8'); assert.ok(raw === '' || raw.endsWith('\n'));
      assert.ok(Buffer.byteLength(raw) + Buffer.byteLength(JSON.stringify({ kind: 'limit', ordinal: 65 }) + '\n') <= 65536);
      const records = raw === '' ? [] : raw.slice(0, -1).split('\n').map(line => object(JSON.parse(line)));
      assert.ok(records.length <= 65); const references = new Set<string>();
      for (const [index, row] of records.entries()) {
        validateSourceRefusal(row, true); assert.equal(row.ordinal, index + 1); assert.ok(index < 64); assert.notEqual(row.kind, 'limit');
        if (row.kind === 'reference') { const pair = text(row.commandDigest) + ':' + text(row.contextDigest); assert.equal(references.has(pair), false); references.add(pair); }
      }
      const consumers = records.filter(row => row.kind === 'consumer').map(row => {
        const matches = diagnosticLaunches.filter(value => value.actionDigest === row.actionDigest && value.bindingDigests.includes(text(row.bindingDigest)));
        assert.equal(matches.length, 1); return { row, launch: matches[0]! };
      });
      const observations = records.map(row => {
        if (row.kind === 'opencode-open') {
          const matches = diagnosticLaunches.filter(value => value.bindingDigests.includes(text(row.bindingDigest)));
          assert.equal(matches.length, 1); return { ...row, launchId: matches[0]!.launchId, source: matches[0]!.source };
        }
        if (row.kind === 'native') { const matches = epochs.flatMap(epoch => epoch.jobs).filter(job => job.capability === row.capability);
          assert.equal(matches.length, 1); assert.ok(matches[0]!.origin); const { capability: _capability, ...observed } = row;
          return { ...observed, source: sourceRef(matches[0]!.origin) }; }
        const matches = row.kind === 'consumer' ? consumers.filter(value => value.row === row) :
          consumers.filter(value => value.row.groupDigest === runtimeDigest({ commandDigest: row.commandDigest, contextDigest: row.contextDigest }));
        assert.ok(matches.length > 0); assert.equal(new Set(matches.map(value => JSON.stringify(value.launch))).size, 1);
        return { ...row, launchId: matches[0]!.launch.launchId, source: matches[0]!.launch.source };
      });
      evidence.firstRefusal = records.length ? { status: 'observed', observations } : { status: 'unknown', reason: 'empty' };
    } catch { evidence.firstRefusal = { status: 'unknown', reason: 'unreadable-invalid-overflow-or-unjoined' }; }
    if (failure) try {
      const diagnostic = JSON.stringify({ kind: 'TEST_SOURCE_FIRST_REFUSAL', provider, diagnostic: evidence.firstRefusal });
      console.log(Buffer.byteLength(diagnostic) <= 65536 ? diagnostic : JSON.stringify({ kind: 'TEST_SOURCE_FIRST_REFUSAL', provider, diagnostic: { status: 'unknown', reason: 'projection-limit' } }));
    } catch { /* Preserve the original failure even if its bounded diagnostic cannot be written. */ }
  }
  if (failure) throw failure;
  assert.ok(complete && evidence.cleanup === true); evidence.status = 'PASS'; evidence.stage = 'complete';
}
