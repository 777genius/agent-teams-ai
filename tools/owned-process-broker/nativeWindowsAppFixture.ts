/** TEST original packaged Main custody; every witness is query/synchronize only. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { windowsServiceCaptureSchema, serviceSource } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import type { WindowsServiceCapture } from '../../packages/legacy-agent-host/dist/owned-process/retainedServiceContracts.js';
import type { ProcessCommandReceipt } from '../../packages/legacy-agent-host/dist/process/registeredProcessContracts.js';
import { validateProcessReceipt } from '../../packages/legacy-agent-host/dist/process/validateProcessRecords.js';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { formatTeamMessage } from '../../packages/legacy-agent-host/dist/team/formatTeamMessage.js';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import { readProcessServices, probeProcessService } from '../../scripts/legacy-agent-host/desktop-native-process-fixture.ts';
import { PROCESS_BOOTSTRAP, PROCESS_REGISTER_ID, PROCESS_NEIGHBOR_REGISTER_ID, PROCESS_LABEL,
  PROCESS_NEIGHBOR_LABEL, startProcessModel } from '../../scripts/legacy-agent-host/desktop-native-process-model.ts';
import { readDesktopNativeStopSessions } from '../../scripts/legacy-agent-host/desktop-native-stop-fixture.ts';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { prepareProfile } from './nativeRetainedHostGate';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (path: string) => sha(readFileSync(path));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const remaining = (deadline: number) => {
  const value = Math.floor(deadline - performance.now());
  assert.ok(value > 0, 'Original Windows UI phase deadline');
  return value;
};
function json(path: string) {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 65536);
  assert.equal(realpathSync.native(path), path);
  return object(JSON.parse(readFileSync(path, 'utf8')));
}
type Role = 'primary' | 'neighbor';
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
interface OriginalProcess {
  receipt: ProcessCommandReceipt;
  capture: WindowsServiceCapture;
  view: Record<string, unknown>;
  witness: Witness;
}
interface OriginalStop {
  deadline: number;
  completed: boolean;
  ready: Promise<void>;
  finish(): void;
}
export async function prepareNativeWindowsAppFixture(options: {
  root: string;
  broker: string;
  fixture: string;
  selectionPath: string;
  selectionSha256: string;
  packaged: { nodeExecutable: string; nodeVersion: string; hostEntry: string };
}) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
  const root = realpathSync.native(options.root);
  assert.equal(root, options.root);
  assert.match(options.selectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(options.selectionPath), options.selectionSha256);
  const selected = JSON.parse(readFileSync(options.selectionPath, 'utf8')) as Parameters<typeof prepareProfile>[2];
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.testOnly, true);
  assert.equal(selected.platform, 'win32-' + process.arch);
  assert.equal(selected.provider, undefined); assert.equal(selected.version, '0.3.305');
  assert.equal(basename(options.broker), 'owned-process-broker.exe');
  const brokerManifest = json(join(dirname(options.broker), 'manifest.json'));
  assert.deepEqual(Object.keys(brokerManifest).sort(), ['arch', 'capability', 'file', 'platform', 'protocol', 'schema', 'sha256']);
   assert.equal(brokerManifest.schema, 2); assert.equal(brokerManifest.platform, 'win32');
   assert.equal(brokerManifest.arch, process.arch); assert.equal(brokerManifest.protocol, 1);
   assert.equal(brokerManifest.file, 'owned-process-broker.exe'); assert.equal(brokerManifest.sha256, hash(options.broker));
   assert.equal(brokerManifest.capability, 'service-scopes-v1');
  for (const path of [options.broker, options.fixture, selected.executable.path, options.packaged.nodeExecutable]) {
    assert.equal(realpathSync.native(path), path);
    verifyBrokerArchitecture(readFileSync(path), process.arch);
  }
  assert.equal(realpathSync.native(selected.bash.path), selected.bash.path);
  assert.equal(hash(selected.executable.path), selected.executable.sha256);
  assert.equal(hash(selected.bash.path), selected.bash.sha256);
  const actorSource = new URL('../../scripts/legacy-agent-host/fixtures/process-foreground-service.ts', import.meta.url);
  const actorBytes = readFileSync(actorSource);
  const actor = join(root, 'workspace/process-foreground-service.ts');
  const stops = new Map<Role, OriginalStop>(), original = new Map<Role, OriginalProcess>();
  const events = createNativeGateEvents(), witnesses = new Set<ChildProcess>();
  const exits = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
  const track = (child: ChildProcess) => {
    witnesses.add(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('exit', (code, signal) => done({ code, signal }));
      child.once('error', reject);
    });
    void exited.catch(() => undefined);
    exits.set(child, exited);
  };
  const within = async <T>(deadline: number, action: () => Promise<T>) => {
    remaining(deadline);
    return timeout(events.wait(action()), remaining(deadline));
  };
  const model = await startProcessModel({
    bashCommand: () => quote(options.packaged.nodeExecutable) + ' ' + quote(actor) + ' ' + quote(root),
    services: () => readProcessServices(root),
    serviceLifecycle: async role => {
      const bytes = readFileSync(join(root, 'workspace/process-' + role + '-lifecycle.ndjson'));
      assert.ok(bytes.length > 0 && bytes.length <= 16384);
      const lines = bytes.toString('utf8').trim().split('\n');
      assert.ok(lines.length >= 1 && lines.length <= 3);
      return lines.map(line => object(JSON.parse(line)));
    },
    windowsScopedServices: {
      async originalScopedStop(role) {
        const stop = stops.get(role);
        assert.ok(stop, 'Only the original explicit UI Stop can admit its notification');
        if (!stop.completed) await within(stop.deadline, () => stop.ready);
        assert.equal(stop.completed, true, 'Receipt and retained target HANDLE absence precede the ACK');
      },
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const child of witnesses) if (child.exitCode === null && !child.stdin?.destroyed) child.stdin?.end();
    await model.close();
  };
  try {
    const prepared = prepareProfile(root, options.broker, selected, model.url, 'scoped-services', profile => {
      profile.owner.storageRoot = join(root, 'hoststore');
      mkdirSync(profile.owner.storageRoot);
      profile.teams[0]!.members[0]!.role = 'lead';
    }, options.packaged);
    const team = prepared.profile.teams[0]!;
    const seed = { schemaVersion: 1, node: options.packaged.nodeExecutable, ttlMs: 300000,
      roles: { primary: { nonce: 'TEST-' + randomUUID() }, neighbor: { nonce: 'TEST-' + randomUUID() } } };
    const seedPath = join(root, 'process-ui-seed.json');
    writeFileSync(seedPath, JSON.stringify(seed), { flag: 'wx' });
    writeFileSync(actor, actorBytes, { flag: 'wx' });
    const lease = acquireProfileWriterLease(prepared.profile.owner.storageRoot);
    const uiSeed = { subject: 'TEST same Main Windows original Processes', commandId: 'TEST-Windows-process-sidebar' };
    try {
      lease.assertCurrent();
      const owner = createFilesystemTeamOwner({ root: prepared.profile.owner.storageRoot,
        binding: team.binding, members: team.members, grants: team.grants }).connect(prepared.profile.principalId);
      const receipt = owner.execute({ commandId: uiSeed.commandId, operation: 'task.create', payload: { subject: uiSeed.subject } });
      assert.equal(receipt.phase, 'completed');
      assert.equal(owner.listTasks().length, 1);
      writeFileSync(join(root, 'ui-seed-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
    } finally { lease.release(); }
    const handleId = 'TEST-windows-same-main-' + randomUUID();
    const owner = { ownerId: prepared.profile.owner.ownerId, revision: prepared.profile.owner.revision };
    const descriptor = { schemaVersion: 1, defaultOwner: owner,
      owners: [{ ...owner, storageRoot: prepared.profile.owner.storageRoot, profile: prepared.host }],
      handles: [{ handleId, owner, contextId: 'local', label: team.binding.teamName, scope: team.scope,
        members: team.members.map(member => ({ memberId: member.memberId, label: member.name })) }] };
    const descriptorPath = join(root, 'TEST-desktop-descriptor.json');
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { flag: 'wx' });
    const pinnedPaths = [options.selectionPath, options.broker, join(dirname(options.broker), 'manifest.json'),
      options.fixture, selected.executable.path, selected.bash.path, options.packaged.nodeExecutable,
      options.packaged.hostEntry, prepared.source, prepared.host.hostEntry, seedPath, actor, descriptorPath];
    const pins = pinnedPaths.map(path => ({ path, sha256: hash(path) }));
    const assertPins = () => {
      for (const pin of pins) assert.equal(hash(pin.path), pin.sha256, 'Original captured Windows fixture source');
      assert.equal(sha(readFileSync(actorSource)), sha(actorBytes));
    };
    const commandDirectory = join(prepared.profile.owner.storageRoot, 'teams', team.binding.teamName, '.host-owner', 'commands');
    const processReceipt = (commandId: string) => {
      const value = json(join(commandDirectory, digest(commandId) + '.json'));
      const receipt = validateProcessReceipt(value as unknown as ProcessCommandReceipt, digest);
      assert.equal(receipt.commandId, commandId);
      assert.deepEqual(receipt.binding, team.binding);
      return receipt;
    };
    const processReceipts = () => {
      const names = readdirSync(commandDirectory);
      assert.ok(names.length <= 64);
      const rows = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => json(join(commandDirectory, name)));
      const receipts = rows.filter(row => row.family === 'process')
        .map(row => validateProcessReceipt(row as unknown as ProcessCommandReceipt, digest));
      for (const receipt of receipts) {
        assert.deepEqual(receipt.binding, team.binding);
        assert.ok(receipt.commandId === PROCESS_REGISTER_ID || receipt.commandId === PROCESS_NEIGHBOR_REGISTER_ID ||
          receipt.operation === 'terminate', 'Only original registrations and the two explicit UI Stops');
      }
      assert.ok(receipts.length <= 2 + stops.size);
      return receipts;
    };
    const bootstrap = { commandId: 'TEST-native-process-bootstrap', payload: { to: 'alice',
      text: PROCESS_BOOTSTRAP, messageId: 'TEST-native-process-bootstrap', actionMode: 'do' as const } };
    const originalContent = formatTeamMessage(bootstrap.payload, 'user', bootstrap.commandId, 'lead');
    let runtimeBefore: Record<string, unknown> | undefined, provider: Witness | undefined;
    let phase: 'prepared' | 'captured' | 'exited' | 'recovered' | 'completed' = 'prepared';
    const runtimeIdentity = async () => {
      const rows = await readDesktopNativeStopSessions(root);
      assert.equal(rows.length, 1, 'Exactly one original Runtime generation, including after recovery');
      const row = rows[0]!, binding = object(row.binding), config = object(row.config);
      assert.equal(binding.backendId, team.binding.backendId); assert.equal(binding.teamId, team.binding.teamId);
      assert.equal(binding.memberId, 'alice-id'); assert.equal(row.profileId, prepared.profile.owner.profileId);
      assert.match(String(row.openFingerprint), /^[a-f0-9]{64}$/);
      assert.ok(typeof row.sessionRef === 'string' && row.sessionRef.length > 0);
      assert.ok(Array.isArray(row.inputs) && row.inputs.length === 1);
      const input = object(row.inputs[0]), intent = object(input.intent);
      assert.equal(input.phase, 'terminal'); assert.equal(input.terminal, 'succeeded');
      assert.deepEqual(intent.binding, binding); assert.equal(intent.content, originalContent);
      assert.equal(intent.messageId, bootstrap.commandId);
      const value = { binding, config, profileId: row.profileId, openFingerprint: row.openFingerprint,
        sessionRef: row.sessionRef, inputs: row.inputs, checkpoints: row.checkpoints ?? [] };
      if (runtimeBefore) assert.deepEqual(value, runtimeBefore, 'Recovery/Stop never remints or replays Runtime history');
      return structuredClone(value);
    };
    const assertModel = () => {
      assert.deepEqual(model.failures, []); assert.equal(model.probes.length, 0);
      assert.deepEqual(model.observations.map(row => [row.turn, row.step]),
        [0, 1, 2, 3].map(step => [PROCESS_BOOTSTRAP, step]));
      assert.ok(model.notificationAcks.length <= 2);
    };
    const assertRows = (value: unknown) => {
      assert.ok(Array.isArray(value) && value.length === 2);
      for (const role of ['primary', 'neighbor'] as const) {
        const expected = original.get(role);
        assert.ok(expected);
        const found: Record<string, unknown>[] = value.map(object).filter(row => row.id === expected.view.id);
        assert.equal(found.length, 1);
        const stopped = stops.get(role)?.completed === true;
        assert.deepEqual(found[0], { ...expected.view, observation: stopped ? 'absent' : 'same-live', canTerminate: !stopped });
      }
    };
    return {
      root, prepared, model, bootstrap, uiSeed, handleId, descriptorPath, descriptorSha256: hash(descriptorPath), pins,
      assertPins, assertRows, runtimeIdentity, close,
      writer() {
        const path = join(prepared.profile.owner.storageRoot, '.legacy-agent-host-writer.lock');
        const info = lstatSync(path, { bigint: true });
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0n && info.size <= 512n);
        assert.equal(realpathSync.native(path), path);
        const bytes = readFileSync(path, 'utf8');
        const match = /^([1-9][0-9]*)\n([0-9]+)\n([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\n$/.exec(bytes);
        assert.ok(match, 'Original controller PID/time/token writer publication');
        const pid = Number(match[1]), publishedAtMs = Number(match[2]);
        assert.ok(Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(publishedAtMs) && publishedAtMs > 0);
        return { pid, token: match[3]!, publishedAtMs, sha256: hash(path), dev: String(info.dev), ino: String(info.ino) };
      },
      async captureOriginal(deadline: number) {
        assert.equal(phase, 'prepared'); assertPins(); assertModel();
        runtimeBefore = await runtimeIdentity();
        const binding = object(runtimeBefore.binding);
        const services = await readProcessServices(root);
        for (const role of ['primary', 'neighbor'] as const) {
          const receipt = processReceipt(role === 'primary' ? PROCESS_REGISTER_ID : PROCESS_NEIGHBOR_REGISTER_ID);
          assert.equal(receipt.operation, 'register'); assert.equal(receipt.phase, 'completed');
          assert.equal(receipt.principalId, 'alice-session'); assert.equal(receipt.nativeAbsence, undefined);
          const capture = windowsServiceCaptureSchema.parse(receipt.capture);
          assert.deepEqual(capture.registrar, binding);
          assert.equal(capture.target.pid, services[role].pid);
          assert.ok(receipt.nativeIntent?.command.operation === 'capture');
          assert.deepEqual(serviceSource(receipt.nativeIntent), serviceSource(capture));
          assert.deepEqual(receipt.nativeIntent.command.registrar, capture.registrar);
          assert.equal(receipt.nativeIntent.command.pid, capture.target.pid);
          const view = object(receipt.result);
          assert.equal(view.observation, 'unknown'); assert.equal(view.canTerminate, false);
          assert.equal(view.pid, capture.target.pid);
          assert.equal(view.label, role === 'primary' ? PROCESS_LABEL : PROCESS_NEIGHBOR_LABEL);
          const witness = await within(deadline, () => capturedQueryableWitness(options.fixture,
            capture.target.pid, capture.target.birth, track, events));
          original.set(role, { receipt, capture, view: structuredClone(view), witness });
          assert.equal(await within(deadline, () => witness.observe()), 'alive');
          await within(deadline, () => probeProcessService(services[role]));
        }
        const primary = original.get('primary')!, neighbor = original.get('neighbor')!;
        assert.deepEqual(serviceSource(primary.capture), serviceSource(neighbor.capture));
        assert.notEqual(primary.capture.target.key, neighbor.capture.target.key);
        assert.notEqual(primary.view.processRef, neighbor.view.processRef);
        provider = await within(deadline, () => capturedQueryableWitness(options.fixture,
          primary.capture.root.pid, primary.capture.root.birth, track, events));
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        phase = 'captured';
        return { source: serviceSource(primary.capture), runtime: runtimeBefore,
          registrations: [primary.receipt, neighbor.receipt], rows: [primary.view, neighbor.view] };
      },
      crashOriginal() {
        assert.equal(phase, 'captured');
        writeFileSync(prepared.crash, 'TEST original Host only\n', { flag: 'wx' });
      },
      async afterOriginalExit(deadline: number) {
        assert.equal(phase, 'captured');
        // Driver has already positively observed the original Host PID/birth absent.
        unlinkSync(prepared.crash);
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        assertPins(); assertModel(); await runtimeIdentity(); phase = 'exited';
      },
      async afterRetry(deadline: number) {
        assert.equal(phase, 'exited');
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        for (const role of ['primary', 'neighbor'] as const) {
          const selected = original.get(role)!;
          assert.equal(await within(deadline, () => selected.witness.observe()), 'alive');
          assert.deepEqual(processReceipt(selected.receipt.commandId), selected.receipt);
        }
        assertPins(); assertModel(); await runtimeIdentity(); phase = 'recovered';
      },
      beginStop(role: Role, deadline: number) {
        assert.equal(phase, 'recovered'); assert.equal(stops.has(role), false);
        assert.ok(remaining(deadline) <= 10000);
        assert.equal(stops.size, role === 'primary' ? 0 : 1);
        if (role === 'neighbor') assert.equal(stops.get('primary')?.completed, true);
        let finish!: () => void;
        const ready = new Promise<void>(done => { finish = done; });
        stops.set(role, { deadline, completed: false, ready, finish });
      },
      async completeStop(role: Role) {
        const stop = stops.get(role), selected = original.get(role);
        assert.ok(stop && selected && !stop.completed);
        let receipt: ProcessCommandReceipt;
        for (;;) {
          remaining(stop.deadline); assertModel();
          const found = processReceipts().filter(row => row.operation === 'terminate' && row.processRef === selected.view.processRef);
          assert.ok(found.length <= 1, 'One original UI command for this exact processRef');
          const candidate = found[0];
          if (candidate?.phase === 'completed' && candidate.state.phase === 'completed' &&
            candidate.state.native === 'observed-absent') { receipt = candidate; break; }
          assert.ok(!candidate || candidate.phase === 'prepared' || candidate.phase === 'held');
          await delay(Math.min(25, remaining(stop.deadline)));
        }
        assert.equal(receipt.principalId, 'human'); assert.deepEqual(receipt.capture, selected.capture);
        assert.deepEqual(receipt.original?.capturedNative, selected.capture); assert.equal(receipt.original?.id, selected.view.id);
        assert.ok(receipt.nativeIntent?.command.operation === 'stop');
        assert.ok(receipt.nativeSettlement?.command.operation === 'settle');
        for (const intent of [receipt.nativeIntent, receipt.nativeSettlement]) {
          assert.ok(intent.command.operation === 'stop' || intent.command.operation === 'settle');
          assert.deepEqual(serviceSource(intent), serviceSource(selected.capture));
          assert.deepEqual(intent.command.capture, selected.capture);
        }
        assert.notEqual(receipt.nativeIntent.operationRef, receipt.nativeSettlement.operationRef);
        assert.equal(receipt.nativeSettlementNotDispatched, undefined);
        assert.ok(receipt.state.phase === 'completed' && receipt.state.native === 'observed-absent');
        assert.equal(receipt.state.signalAccepted, 'unknown');
        const after = object(receipt.result);
        assert.equal(after.id, selected.view.id); assert.equal(after.pid, selected.view.pid);
        assert.equal(after.observation, 'absent'); assert.equal(after.canTerminate, false);
        assert.ok(typeof after.stoppedAt === 'string'); assert.notEqual(after.processRef, selected.view.processRef);
        assert.equal(await within(stop.deadline, () => selected.witness.observe()), 'absent');
        assert.equal(await within(stop.deadline, () => selected.witness.wait()), 0);
        if (role === 'primary')
          assert.equal(await within(stop.deadline, () => original.get('neighbor')!.witness.observe()), 'alive');
        selected.view = structuredClone(after); stop.completed = true; stop.finish();
        while (!model.notificationAcks.some(ack => ack.role === role && ack.responseFinished)) {
          assertModel(); await delay(Math.min(25, remaining(stop.deadline)));
        }
        const acks = model.notificationAcks.filter(ack => ack.role === role);
        assert.equal(acks.length, 1); assert.equal(acks[0]!.exitReason, 'original-service-scope');
        assert.equal(acks[0]!.servicePid, selected.capture.target.pid);
        if (role === 'neighbor') assert.equal(await within(stop.deadline, () => provider!.observe()), 'alive');
        assertPins(); assertModel(); await runtimeIdentity();
        return structuredClone(receipt);
      },
      async afterQuit(deadline: number) {
        assert.equal(stops.size, 2); assert.ok([...stops.values()].every(stop => stop.completed));
        assert.equal(await within(deadline, () => provider!.wait()), 0);
        assert.equal(witnesses.size, 3);
        for (const child of witnesses) assert.deepEqual(await within(deadline, () => exits.get(child)!), { code: 0, signal: null });
        assert.throws(() => lstatSync(join(prepared.profile.owner.storageRoot, '.legacy-agent-host-writer.lock')), { code: 'ENOENT' });
        assertPins(); assertModel(); await runtimeIdentity();
        assert.equal(model.notificationAcks.length, 2); phase = 'completed';
        return { phase, originalQueryWitnesses: 3, runtimeGenerations: 1, runtimeInputs: 1,
          modelRequests: model.observations.length, probes: model.probes.length,
          notificationAcknowledgements: model.notificationAcks.length, originalUiStops: stops.size };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
