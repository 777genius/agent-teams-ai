/** TEST original packaged Main custody; every witness is query/synchronize only. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { readDesktopNativeStopSessions } from '../../scripts/legacy-agent-host/desktop-native-stop-fixture.ts';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { prepareEmulatedProfile } from './nativeEmulatedProfile';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (path: string) => sha(readFileSync(path));
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
const roles = ['primary', 'neighbor'] as const;
const label = (role: Role) => `TEST-${role}`;
const registration = (role: Role) => `TEST-register-${label(role)}`;
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
  ledgerIndex: number;
}
function ledger(path: string, maximumRows: number): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 65536);
  assert.equal(realpathSync.native(path), path);
  const bytes = readFileSync(path);
  assert.ok(bytes.length <= 65536);
  if (!bytes.length) return [];
  assert.equal(bytes.at(-1), 10, 'Only complete original event rows');
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  assert.ok(lines.length <= maximumRows);
  return lines.map(line => object(JSON.parse(line)));
}
function fields(row: Record<string, unknown>, names: string[]) {
  assert.deepEqual(Object.keys(row).sort(), [...names].sort());
}
export async function prepareNativeWindowsAppFixture(options: {
  root: string;
  broker: string;
  fixture: string;
  controller: string;
  appUserData: string;
  packaged: { nodeExecutable: string; nodeVersion: string; hostEntry: string };
}) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, undefined);
  const root = realpathSync.native(options.root);
  assert.equal(root, options.root);
  assert.equal(realpathSync.native(options.appUserData), options.appUserData);
  assert.equal(basename(options.controller), 'owned-process-gate-controller.exe');
  assert.equal(basename(options.broker), 'owned-process-broker.exe');
  const brokerManifest = json(join(dirname(options.broker), 'manifest.json'));
  assert.deepEqual(Object.keys(brokerManifest).sort(), ['arch', 'capability', 'file', 'platform', 'protocol', 'schema', 'sha256']);
  assert.equal(brokerManifest.schema, 2); assert.equal(brokerManifest.platform, 'win32');
  assert.equal(brokerManifest.arch, process.arch); assert.equal(brokerManifest.protocol, 1);
  assert.equal(brokerManifest.file, 'owned-process-broker.exe'); assert.equal(brokerManifest.sha256, hash(options.broker));
  assert.equal(brokerManifest.capability, 'service-scopes-v1');
  for (const path of [options.broker, options.fixture, options.controller, options.packaged.nodeExecutable]) {
    assert.equal(realpathSync.native(path), path);
    verifyBrokerArchitecture(readFileSync(path), process.arch);
  }
  const metadataLedger = join(root, 'TEST-metadata-events.ndjson');
  writeFileSync(metadataLedger, '', { flag: 'wx' });
  const metadataPaths: string[] = [], metadataCli = { codex: '', claude: '' };
  for (const [provider, version] of [['codex', 'codex-cli 0.164.0'], ['claude', '2.1.0 (Claude Code)']] as const) {
    const script = join(root, `TEST-${provider}-metadata.cjs`), wrapper = script.replace(/\.cjs$/, '.cmd');
    writeFileSync(script, `#!${options.packaged.nodeExecutable}\n'use strict';\n` +
      `const fs = require('node:fs');\nconst args = process.argv.slice(2);\n` +
      `const accepted = args.length === 1 && args[0] === '--version';\n` +
      `fs.appendFileSync(${JSON.stringify(metadataLedger)}, JSON.stringify({ provider: ${JSON.stringify(provider)}, kind: accepted ? 'version' : 'refused', args }) + '\\n');\n` +
      `if (accepted) { process.stdout.write(${JSON.stringify(version + '\n')}); process.exit(0); }\n` +
      `process.stderr.write(${JSON.stringify('TEST ' + provider + ' refuses non-version commands\n')}); process.exit(77);\n`,
    { flag: 'wx' });
    writeFileSync(wrapper, `@echo off\r\n"${options.packaged.nodeExecutable}" "${script}" %*\r\n`, { flag: 'wx' });
    metadataCli[provider] = wrapper; metadataPaths.push(script, wrapper);
  }
  const metadataHome = join(root, 'TEST-metadata-codex-home'); mkdirSync(metadataHome);
  const metadataSelection = join(options.appUserData, 'data/runtimes/codex/current.json');
  mkdirSync(dirname(metadataSelection), { recursive: true });
  writeFileSync(metadataSelection, JSON.stringify({ schemaVersion: 1,
    rootVersion: '0.164.0', platformVersion: '0.164.0', platformTarget: `TEST-win32-${process.arch}`,
    binaryPath: metadataCli.codex, integrity: 'TEST-finite-metadata-only', installedAt: new Date().toISOString() }), { flag: 'wx' });
  metadataPaths.push(metadataSelection);
  const metadataEnvironment = Object.freeze({ CLAUDE_CLI_PATH: metadataCli.claude,
    CODEX_CLI_PATH: metadataCli.codex, CODEX_HOME: metadataHome });
  const stops = new Map<Role, OriginalStop>(), original = new Map<Role, OriginalProcess>();
  const events = createNativeGateEvents(), witnesses = new Set<ChildProcess>();
  const exits = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
  const observedExits = new Map<ChildProcess, { code: number | null; signal: NodeJS.Signals | null }>();
  const track = (child: ChildProcess) => {
    witnesses.add(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('exit', (code, signal) => { observedExits.set(child, { code, signal }); done({ code, signal }); });
      child.once('error', reject);
    });
    void exited.catch(() => undefined);
    exits.set(child, exited);
  };
  let lastDeadline: number | undefined;
  const within = async <T>(deadline: number, action: () => Promise<T>) => {
    lastDeadline = deadline;
    remaining(deadline);
    return timeout(events.wait(action()), remaining(deadline));
  };
  let closeFlight: Promise<{ confirmed: true; witnesses: number }> | undefined;
  const close = (deadline = lastDeadline) => {
    closeFlight ??= (async () => {
      for (const child of witnesses) if (!observedExits.has(child) && !child.stdin?.destroyed) child.stdin?.end();
      if (observedExits.size !== witnesses.size) {
        assert.ok(deadline !== undefined, 'Original cleanup phase owns witness disposal');
        await timeout(Promise.all(exits.values()), remaining(deadline));
      }
      assert.equal(observedExits.size, witnesses.size, 'Every original witness exit is confirmed');
      return { confirmed: true as const, witnesses: witnesses.size };
    })();
    return closeFlight;
  };
  try {
    const prepared = await prepareEmulatedProfile(root, options.broker, options.fixture, 'codex', options.packaged);
    const crash = prepared.crash; assert.ok(crash);
    const birthPath = prepared.hostBirths; assert.ok(birthPath);
    const birthFile = lstatSync(birthPath);
    assert.deepEqual(ledger(birthPath, 2), []);
    let birthPrefix: { pid: number; parentPid: number }[] = [];
    const hostBirths = () => {
      assert.ok(existsSync(birthPath), 'Original Host birth journal remains present');
      const current = lstatSync(birthPath);
      assert.equal(current.dev, birthFile.dev); assert.equal(current.ino, birthFile.ino);
      const rows = ledger(birthPath, 2).map(row => {
        fields(row, ['pid', 'parentPid']);
        assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 1);
        assert.ok(Number.isSafeInteger(row.parentPid) && Number(row.parentPid) > 1);
        return { pid: Number(row.pid), parentPid: Number(row.parentPid) };
      });
      assert.deepEqual(rows.slice(0, birthPrefix.length), birthPrefix, 'Original Host births are append-only');
      assert.equal(new Set(rows.map(row => row.pid)).size, rows.length);
      birthPrefix = structuredClone(rows);
      return rows;
    };
    const team = prepared.profile.teams[0]!;
    const lease = acquireProfileWriterLease(prepared.profile.owner.storageRoot);
    const uiSeed = { subject: 'TEST same Main Windows original Processes', commandId: 'TEST-Windows-process-sidebar' };
    const uiSeedPath = join(root, 'ui-seed-receipt.json');
    try {
      lease.assertCurrent();
      const owner = createFilesystemTeamOwner({ root: prepared.profile.owner.storageRoot,
        binding: team.binding, members: team.members, grants: team.grants }).connect(prepared.profile.principalId);
      const receipt = owner.execute({ commandId: uiSeed.commandId, operation: 'task.create', payload: { subject: uiSeed.subject } });
      assert.equal(receipt.phase, 'completed');
      assert.equal(owner.listTasks().length, 1);
      writeFileSync(uiSeedPath, JSON.stringify(receipt), { flag: 'wx' });
    } finally { lease.release(); }
    const handleId = 'TEST-windows-same-main-' + randomUUID();
    const owner = { ownerId: prepared.profile.owner.ownerId, revision: prepared.profile.owner.revision };
    const descriptor = { schemaVersion: 1, defaultOwner: owner,
      owners: [{ ...owner, storageRoot: prepared.profile.owner.storageRoot, profile: prepared.host }],
      handles: [{ handleId, owner, contextId: 'local', label: team.binding.teamName, scope: team.scope,
        members: team.members.map(member => ({ memberId: member.memberId, label: member.name })) }] };
    const descriptorPath = join(root, 'TEST-desktop-descriptor.json');
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { flag: 'wx' });
    const pinnedPaths = [options.broker, join(dirname(options.broker), 'manifest.json'), options.controller,
      options.fixture, descriptorPath, uiSeedPath, ...metadataPaths];
    const pins = [...prepared.pathPins, ...pinnedPaths.map(path => ({ path, sha256: hash(path) }))];
    const assertPins = () => {
      for (const pin of pins) assert.equal(hash(pin.path), pin.sha256, 'Original captured Windows fixture source');
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
        assert.ok(roles.some(role => receipt.commandId === registration(role)) ||
          receipt.operation === 'terminate', 'Only original registrations and the two explicit UI Stops');
      }
      assert.ok(receipts.length <= 2 + stops.size);
      return receipts;
    };
    const bootstrap = { commandId: 'TEST-native-process-bootstrap', payload: { to: 'alice',
      text: 'TEST-register-services', messageId: 'TEST-native-process-bootstrap', actionMode: 'do' as const } };
    const originalContent = formatTeamMessage(bootstrap.payload, 'user', bootstrap.commandId, 'lead');
    let runtimeBefore: Record<string, unknown> | undefined, provider: Witness | undefined;
    let phase: 'prepared' | 'captured' | 'exited' | 'recovered' | 'completed' = 'prepared';
    const runtimeIdentity = async () => {
      const rows = await readDesktopNativeStopSessions(prepared.root);
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
    let peerPrefix: Record<string, unknown>[] = [], metadataPrefix: Record<string, unknown>[] = [];
    const peerState = () => {
      const rows = ledger(prepared.effects, 4);
      assert.deepEqual(rows.slice(0, peerPrefix.length), peerPrefix, 'Original peer ledger is append-only');
      const connections = rows.filter(row => row.event === 'connected');
      const registrations = rows.filter(row => row.event === 'registered');
      assert.ok(connections.length <= 1 && registrations.length <= 1);
      const connection = connections[0], registered = registrations[0];
      if (connection) {
        assert.equal(rows[0], connection); fields(connection, ['event', 'provider', 'pid', 'tools']);
        assert.equal(connection.provider, 'codex');
        assert.ok(Number.isSafeInteger(connection.pid) && Number(connection.pid) > 1);
        assert.ok(Array.isArray(connection.tools) && connection.tools.length <= 256);
        assert.ok(connection.tools.every(tool => typeof tool === 'string' && tool.length > 0 && tool.length <= 128));
        assert.equal(new Set(connection.tools).size, connection.tools.length);
        assert.ok(connection.tools.includes('process_register'));
      }
      let services: Record<string, unknown>[] = [];
      if (registered) {
        assert.ok(connection); assert.equal(rows[1], registered); fields(registered, ['event', 'services']);
        assert.ok(Array.isArray(registered.services) && registered.services.length === 2);
        services = registered.services.map(object);
        for (const [index, service] of services.entries()) {
          fields(service, ['label', 'pid', 'processRef']); assert.equal(service.label, label(roles[index]!));
          assert.ok(Number.isSafeInteger(service.pid) && Number(service.pid) > 1 && service.pid !== connection.pid);
          assert.equal(typeof service.processRef, 'string');
          assert.match(String(service.processRef), /^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/);
        }
        assert.notEqual(services[0]!.pid, services[1]!.pid);
        assert.notEqual(services[0]!.processRef, services[1]!.processRef);
      }
      const serviceExits: Record<string, unknown>[] = [];
      for (const [index, row] of rows.entries()) {
        if (row === connection || row === registered) continue;
        fields(row, ['event', 'label', 'pid', 'code']); assert.equal(row.event, 'service-exit');
        const role = roles.find(value => row.label === label(value)); assert.ok(role && registered);
        const service = services.find(value => value.label === row.label), stop = stops.get(role);
        assert.ok(service && stop && index >= stop.ledgerIndex, 'Only an admitted original UI Stop can precede this exit');
        assert.equal(row.pid, service.pid); assert.equal(row.code, 1, 'Natural finite leaf expiry is not UI Stop');
        assert.equal(serviceExits.filter(value => value.label === row.label).length, 0);
        serviceExits.push(row);
      }
      peerPrefix = structuredClone(rows);
      return { rows, connection, services, serviceExits, registrations: registrations.length };
    };
    const metadataState = () => {
      assert.ok(existsSync(metadataLedger), 'Original private metadata ledger remains present');
      const rows = ledger(metadataLedger, 128);
      assert.deepEqual(rows.slice(0, metadataPrefix.length), metadataPrefix, 'Original metadata ledger is append-only');
      const result = { events: rows.length, claudeVersions: 0, codexVersions: 0, refused: 0 };
      for (const row of rows) {
        fields(row, ['provider', 'kind', 'args']);
        assert.ok(row.provider === 'claude' || row.provider === 'codex');
        assert.ok(Array.isArray(row.args) && row.args.length <= 32 &&
          row.args.every(value => typeof value === 'string' && value.length <= 1024));
        const version = row.args.length === 1 && row.args[0] === '--version';
        assert.equal(row.kind, version ? 'version' : 'refused');
        if (!version) result.refused++;
        else if (row.provider === 'claude') result.claudeVersions++;
        else result.codexVersions++;
      }
      metadataPrefix = structuredClone(rows);
      return result;
    };
    const peerEvidence = () => {
      const peer = peerState();
      return { provider: 'codex' as const, connected: peer.connection ? 1 : 0,
        registrations: peer.registrations, serviceExitObservations: peer.serviceExits.length,
        failures: 0, metadata: metadataState(), modelRequests: 0, probes: 0, realVendorExecutions: 0 };
    };
    const assertPeer = () => { peerEvidence(); };
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
      root, prepared, bootstrap, uiSeed, handleId, descriptorPath, descriptorSha256: hash(descriptorPath), pins,
      metadataEnvironment, hostBirths, assertPeer, peerEvidence, assertPins, assertRows, runtimeIdentity, close,
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
        assert.equal(phase, 'prepared'); remaining(deadline); assertPins(); assertPeer();
        runtimeBefore = await runtimeIdentity();
        remaining(deadline);
        const binding = object(runtimeBefore.binding);
        const peer = peerState(); assert.ok(peer.connection); assert.equal(peer.registrations, 1);
        assert.equal(peer.serviceExits.length, 0); assert.equal(peer.services.length, 2);
        for (const role of ['primary', 'neighbor'] as const) {
          const service = peer.services.find(value => value.label === label(role)); assert.ok(service);
          const receipt = processReceipt(registration(role));
          assert.equal(receipt.operation, 'register'); assert.equal(receipt.phase, 'completed');
          assert.equal(receipt.principalId, 'alice-session'); assert.equal(receipt.nativeAbsence, undefined);
          const capture = windowsServiceCaptureSchema.parse(receipt.capture);
          assert.deepEqual(capture.registrar, binding);
          assert.equal(capture.target.pid, service.pid); assert.equal(capture.root.pid, peer.connection.pid);
          assert.ok(receipt.nativeIntent?.command.operation === 'capture');
          assert.deepEqual(serviceSource(receipt.nativeIntent), serviceSource(capture));
          assert.deepEqual(receipt.nativeIntent.command.registrar, capture.registrar);
          assert.equal(receipt.nativeIntent.command.pid, capture.target.pid);
          const view = object(receipt.result);
          assert.equal(view.observation, 'unknown'); assert.equal(view.canTerminate, false);
          assert.equal(view.pid, capture.target.pid);
          assert.equal(view.label, label(role)); assert.equal(view.processRef, service.processRef);
          const witness = await within(deadline, () => capturedQueryableWitness(options.fixture,
            capture.target.pid, capture.target.birth, track, events, 'query-wait-gated'));
          original.set(role, { receipt, capture, view: structuredClone(view), witness });
          assert.equal(await within(deadline, () => witness.observe()), 'alive');
        }
        const primary = original.get('primary')!, neighbor = original.get('neighbor')!;
        assert.deepEqual(serviceSource(primary.capture), serviceSource(neighbor.capture));
        assert.notEqual(primary.capture.target.key, neighbor.capture.target.key);
        assert.notEqual(primary.view.processRef, neighbor.view.processRef);
        provider = await within(deadline, () => capturedQueryableWitness(options.fixture,
          primary.capture.root.pid, primary.capture.root.birth, track, events, 'query-wait-gated'));
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        phase = 'captured';
        return { source: serviceSource(primary.capture), runtime: runtimeBefore,
          registrations: [primary.receipt, neighbor.receipt], rows: [primary.view, neighbor.view] };
      },
      crashOriginal() {
        assert.equal(phase, 'captured');
        writeFileSync(crash, 'TEST original Host only\n', { flag: 'wx' });
      },
      async afterOriginalExit(deadline: number) {
        assert.equal(phase, 'captured');
        // Driver has already positively observed the original Host PID/birth absent.
        unlinkSync(crash);
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        assertPins(); assertPeer(); await runtimeIdentity(); remaining(deadline); phase = 'exited';
      },
      async afterRetry(deadline: number) {
        assert.equal(phase, 'exited');
        assert.equal(await within(deadline, () => provider!.observe()), 'alive');
        for (const role of ['primary', 'neighbor'] as const) {
          const selected = original.get(role)!;
          assert.equal(await within(deadline, () => selected.witness.observe()), 'alive');
          assert.deepEqual(processReceipt(selected.receipt.commandId), selected.receipt);
        }
        assertPins(); assertPeer(); await runtimeIdentity(); remaining(deadline); phase = 'recovered';
      },
      beginStop(role: Role, deadline: number) {
        assert.equal(phase, 'recovered'); assert.equal(stops.has(role), false);
        assert.ok(remaining(deadline) <= 10000);
        lastDeadline = deadline;
        assert.equal(stops.size, role === 'primary' ? 0 : 1);
        if (role === 'neighbor') assert.equal(stops.get('primary')?.completed, true);
        const peer = peerState();
        assert.equal(peer.serviceExits.filter(row => row.label === label(role)).length, 0);
        stops.set(role, { deadline, completed: false, ledgerIndex: peer.rows.length });
      },
      async completeStop(role: Role) {
        const stop = stops.get(role), selected = original.get(role);
        assert.ok(stop && selected && !stop.completed);
        let receipt: ProcessCommandReceipt;
        for (;;) {
          remaining(stop.deadline); assertPeer();
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
        for (;;) {
          remaining(stop.deadline);
          const found = peerState().rows.slice(stop.ledgerIndex)
            .filter(row => row.event === 'service-exit' && row.label === label(role));
          assert.ok(found.length <= 1);
          if (found.length === 1) {
            assert.equal(found[0]!.pid, selected.capture.target.pid); assert.equal(found[0]!.code, 1);
            break;
          }
          await delay(Math.min(25, remaining(stop.deadline)));
        }
        if (role === 'neighbor') assert.equal(await within(stop.deadline, () => provider!.observe()), 'alive');
        assertPins(); assertPeer(); await runtimeIdentity(); remaining(stop.deadline);
        selected.view = structuredClone(after); stop.completed = true;
        return structuredClone(receipt);
      },
      async afterQuit(deadline: number) {
        assert.equal(stops.size, 2); assert.ok([...stops.values()].every(stop => stop.completed));
        assert.equal(await within(deadline, () => provider!.wait()), 0);
        assert.equal(witnesses.size, 3);
        for (const child of witnesses) assert.deepEqual(await within(deadline, () => exits.get(child)!), { code: 0, signal: null });
        assert.throws(() => lstatSync(join(prepared.profile.owner.storageRoot, '.legacy-agent-host-writer.lock')), { code: 'ENOENT' });
        assertPins(); assertPeer(); await runtimeIdentity(); remaining(deadline);
        const peer = peerEvidence();
        assert.equal(peer.connected, 1); assert.equal(peer.registrations, 1);
        assert.equal(peer.serviceExitObservations, 2); phase = 'completed';
        return { phase, cleanup: true, originalQueryWitnesses: 3, runtimeGenerations: 1, runtimeInputs: 1,
          modelRequests: 0, probes: 0, realVendorExecutions: 0,
          serviceExitObservations: 2, originalUiStops: stops.size };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
