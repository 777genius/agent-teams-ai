import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { treeHash, startHost } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { createQualifiedDarwinProcessApi } from '../../packages/legacy-agent-host/dist/process/DarwinRegisteredProcess.js';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { createControllerProcessPolicy } from '../../packages/legacy-agent-host/dist/process/ControllerProcessPolicy.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { digest as teamDigest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { TEAM_HOST_DISPOSE_TIMEOUT_MS } from '../../packages/legacy-agent-host/src/contracts.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { RegisteredProcessCapture } from '../../packages/legacy-agent-host/dist/process/registeredProcessContracts.js';
import { desktopBackendEnvironment, digest, fileDigest } from './desktop-backend-fixture.ts';
import { prepareProcessFixture, probeProcessService, readProcessServices } from './desktop-native-process-fixture.ts';
import { PROCESS_LABEL, qualifyNativeServiceCompletion } from './desktop-native-process-model.ts';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const missing = async (path: string) => access(path).then(() => false, error => {
  if (error.code !== 'ENOENT') throw error; return true;
});
async function pinned(value: unknown) {
  const pin = row(value), path = text(pin.path), sha256 = text(pin.sha256);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024);
  assert.equal(await realpath(path), path); assert.equal(await fileDigest(path), sha256);
  return { path, sha256 };
}
async function until(check: () => Promise<boolean>, budget: number, label: string) {
  const deadline = Date.now() + budget;
  do { if (await check()) return; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Original controlled process observation exhausted: ${label}; no replay`);
}
export interface ControlledProcessUiSource {
  recordFile: string;
  scope: string;
  assertCold(hostPid: number): Promise<void>;
  assertStopped(commandId: string, currentRef: string): Promise<void>;
}

/** Trusted TEST setup; no provider model/session or production capture entrypoint is introduced. */
export async function prepareControlledProcessFixture(repo: string, pnpm: string) {
  assert.equal(process.env.LEGACY_PROCESS_COLD_UI_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined);
  assert.equal(process.env.LEGACY_DESKTOP_READBACK_ROOT, undefined);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  const capturePath = process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH!;
  assert.match(capturePath, /^\/private\/tmp\/TEST-[^/]+\//);
  const capturePin = await pinned({ path: capturePath, sha256: process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 });
  assert.ok((await lstat(capturePath)).size <= 32 * 1024);
  const capture = row(JSON.parse(await readFile(capturePath, 'utf8')));
  assert.equal(capture.schemaVersion, 1);
  const node = await pinned(capture.node), hostPin = await pinned(capture.host), claude = await pinned(capture.claude);
  const corepack = row(capture.corepack);
  const packageEntry = await pinned(corepack.entry), packagePin = await pinned(corepack.package), library = await pinned(corepack.library);
  assert.equal(node.path, await realpath(process.execPath));
  assert.equal(node.path, await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')));
  assert.equal(hostPin.path, await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js')));
  assert.equal(packageEntry.path, pnpm);
  assert.equal(packagePin.path, await realpath(join(dirname(pnpm), '../package.json')));
  assert.equal(library.path, await realpath(join(dirname(pnpm), 'lib/corepack.cjs')));
  const packageJson = row(JSON.parse(await readFile(packagePin.path, 'utf8')));
  assert.equal(packageJson.name, 'corepack'); assert.equal(packageJson.version, '0.36.0');
  assert.equal(claude.sha256, 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f');
  const selection = row(capture.processArtifact);
  const artifact = { directory: text(selection.directory), manifestSha256: text(selection.manifestSha256) };
  assert.match(artifact.directory, /^\/private\/tmp\/TEST-[^/]+\//);
  const bridge = readPackagedProcessArtifact(artifact);
  const manifest = await pinned({ path: join(artifact.directory, 'manifest.json'), sha256: artifact.manifestSha256 });
  const binary = await pinned(bridge);
  const artifactSource = await pinned({ path: join(artifact.directory, 'registered-process-darwin.c'),
    sha256: row(JSON.parse(await readFile(manifest.path, 'utf8'))).sourceSha256 });
  assert.equal(artifactSource.sha256, '310161c5d404d45e4f149b15b88c3805bfeddc4cc4c424460cddee3e845a284b');
  assert.equal(await fileDigest(join(repo, 'packages/legacy-agent-host/native/registered-process-darwin.c')), artifactSource.sha256);
  const fixture = await prepareProcessFixture(repo, { pnpmEntry: pnpm, processArtifact: artifact,
    nativeClaude: { ...claude, modelUrl: 'http://127.0.0.1:9' } });
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  delete profile.runtime; // Controlled service authority is separate from teammate Runtime allocation.
  const profileBytes = JSON.stringify(profile);
  fixture.pins.profileSha256 = digest(profileBytes);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8')) as { owners: { profile: { env: Record<string, string> } }[] };
  descriptor.owners[0]!.profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  const descriptorBytes = JSON.stringify(descriptor);
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.appEnvironment = desktopBackendEnvironment(fixture.root, fixture.node, fixture.descriptorPath, fixture.pins.descriptorSha256);
  const rootScript = join(fixture.root, 'workspace/process-controlled-root.ts');
  await copyFile(join(import.meta.dirname, 'fixtures/process-controlled-root.ts'), rootScript);
  const pins = [capturePin, node, hostPin, claude, packageEntry, packagePin, library, manifest, binary, artifactSource,
    { path: fixture.profilePath, sha256: fixture.pins.profileSha256 },
    { path: fixture.descriptorPath, sha256: fixture.pins.descriptorSha256 }];
  for (const path of [rootScript, join(fixture.root, 'workspace/process-foreground-service.ts'), join(fixture.root, 'process-ui-seed.json')])
    pins.push({ path, sha256: await fileDigest(path) });
  const sourceSha256 = text(row(capture.host).sourceSha256), distSha256 = text(row(capture.host).distSha256);
  const verify = async () => {
    for (const pin of pins) await pinned(pin);
    assert.equal(await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'), sourceSha256);
    assert.equal(await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'), distSha256);
  };
  await verify();
  const native = createQualifiedDarwinProcessApi(bridge);
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', scope: 'Controlled native kernel/canonical owner registration, real Host restart, existing UI original-ref Stop; no SDK session',
    sourcePins: pins, hostSourceSha256: sourceSha256, hostDistSha256: distSha256,
    runtimeCustody: 'NOT_ALLOCATED', original911Unchanged: true };
  let child: ReturnType<typeof spawn> | undefined, hostA: ReturnType<typeof startHost> | undefined;
  let rootCapture: RegisteredProcessCapture | undefined, primaryCapture: RegisteredProcessCapture | undefined, neighborCapture: RegisteredProcessCapture | undefined;
  let hostClosed = false, cleanupStarted = false, hostClose: Promise<void> | undefined;
  let original: Record<string, unknown> | undefined, registrySha256: string | undefined;
  const registry = join(profile.owner.storageRoot, 'teams', profile.teams[0]!.binding.teamName, 'processes.json');
  const writer = join(profile.owner.storageRoot, '.legacy-agent-host-writer.lock');
  const commandsPath = join(dirname(registry), '.host-owner/commands');
  const commandRows = async () => Promise.all((await readdir(commandsPath)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(async name => row(JSON.parse(await readFile(join(commandsPath, name), 'utf8')))));
  const noRuntime = async () => {
    assert.equal(profile.runtime, undefined);
    assert.ok(await missing(join(profile.owner.storageRoot, 'runtime-sessions')), 'no Runtime session store was allocated');
  };
  const closeHost = async () => {
    if (!hostA) return;
    hostClose ??= (async () => {
      hostA!.child.stdin.end();
      await until(async () => hostA!.child.exitCode !== null || hostA!.child.signalCode !== null,
        TEAM_HOST_DISPOSE_TIMEOUT_MS + 2_000, 'Host A EOF exit');
      assert.equal(hostA!.child.exitCode, 0); assert.equal(hostA!.child.signalCode, null);
      assert.ok(await missing(writer), 'first Host writer lock released');
      await hostA!.close();
      hostClosed = true;
      proof.hostA = { ...hostA!.facts(), writerLockReleased: true };
    })();
    await hostClose; // Reobserve the same original EOF result; never send a second EOF or signal.
  };
  const source: ControlledProcessUiSource = {
    recordFile: 'controlled-process-before-restart.json', scope: text(proof.scope),
    async assertCold(hostPid) {
      assert.ok(hostA && hostClosed && original && registrySha256 && primaryCapture);
      assert.notEqual(hostPid, hostA.child.pid);
      assert.equal(await fileDigest(registry), registrySha256);
      assert.equal(native.observe(primaryCapture), 'same-live');
      assert.equal((await commandRows()).filter(value => value.operation === 'terminate').length, 0);
      await noRuntime(); await verify(); proof.hostB = { pid: hostPid, distinctFromHostA: true };
    },
    async assertStopped(commandId, currentRef) {
      assert.ok(original && primaryCapture && neighborCapture);
      const entries = await commandRows(), stops = entries.filter(value => value.operation === 'terminate');
      assert.equal(stops.length, 1); const stop = stops[0]!;
      assert.equal(stop.commandId, commandId); assert.equal(stop.processRef, original.processRef);
      assert.equal(stop.phase, 'completed'); assert.equal(row(stop.state).native, 'observed-absent');
      assert.equal(row(stop.state).signalAccepted, true);
      const canonical = createControllerProcessPolicy(registry).readStrict();
      assert.equal(canonical.length, 1); assert.equal(canonical[0]!.id, original.id);
      assert.ok(canonical[0]!.stoppedAt); assert.deepEqual(canonical[0]!.capturedNative, primaryCapture);
      assert.deepEqual({ ...canonical[0], stoppedAt: undefined }, { ...row(proof.canonicalPrimary), stoppedAt: undefined });
      assert.equal(currentRef, `p1:${canonical[0]!.id}:${teamDigest({ binding: profile.teams[0]!.binding, row: canonical[0] })}`);
      assert.equal(native.observe(primaryCapture), 'absent'); assert.equal(native.observe(neighborCapture), 'same-live');
      const services = await readProcessServices(fixture.root); await probeProcessService(services.neighbor);
      await noRuntime(); proof.neighborHealthyBeforeCleanup = true; proof.stoppedHistory = { canonical, stop };
    },
  };
  const retain = () => writeFile(join(fixture.root, 'controlled-process-cold-ui-receipt.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  const cleanup = async () => {
    if (cleanupStarted) return; cleanupStarted = true;
    const failures: string[] = [];
    try { await closeHost(); } catch (error) { failures.push(String(error)); }
    if (child) {
      child.stdin?.end(); // Only the root's original pipe; wrapper owns its original service handles.
      try {
        await until(async () => child!.exitCode !== null || child!.signalCode !== null, 15_000, 'controlled root EOF cleanup');
        assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
        const result = row(JSON.parse(await readFile(join(fixture.root, 'controlled-process-root-result.json'), 'utf8')));
        const children = (result.children as unknown[]).map(row);
        const primary = children.find(value => value.role === 'primary')!, neighbor = children.find(value => value.role === 'neighbor')!;
        assert.equal(result.rootPid, child.pid);
        for (const value of children) { assert.equal(value.exitCode, 0); assert.equal(value.signalCode, null); assert.equal(value.error, undefined); }
        assert.ok(primaryCapture && neighborCapture && rootCapture, 'all original captures retained before qualification');
        await until(async () => [primaryCapture!, neighborCapture!, rootCapture!].every(value => native.observe(value) === 'absent'), 3_000, 'three original capsules absent');
        const lifecycle = async (role: string) => (await readFile(join(fixture.root, `workspace/process-${role}-lifecycle.ndjson`), 'utf8')).trim().split('\n').map(line => row(JSON.parse(line)));
        const services = await readProcessServices(fixture.root), primaryLifecycle = await lifecycle('primary'), neighborLifecycle = await lifecycle('neighbor');
        const p = qualifyNativeServiceCompletion('primary', services.primary, primaryLifecycle), n = qualifyNativeServiceCompletion('neighbor', services.neighbor, neighborLifecycle);
        if (proof.neighborHealthyBeforeCleanup) {
          assert.equal(primary.cleanupSignals, 0); assert.equal(neighbor.cleanupSignals, 1);
          assert.equal(p.exitReason, 'SIGTERM'); assert.equal(n.exitReason, 'SIGTERM');
        }
        proof.cleanup = { status: 'PASS', rootExitCode: child.exitCode, rootSignalCode: child.signalCode,
          primaryCleanupSignals: primary.cleanupSignals, neighborCleanupSignals: neighbor.cleanupSignals,
          originalTargetObservation: native.observe(primaryCapture), originalNeighborObservation: native.observe(neighborCapture),
          originalRootObservation: native.observe(rootCapture), primaryLifecycle, neighborLifecycle, result };
      } catch (error) { failures.push(String(error)); }
    }
    try { await verify(); } catch (error) { failures.push(String(error)); }
    if (failures.length) { proof.cleanup = { status: 'INCOMPLETE', failures, fixedServiceTtlMs: 300_000, signalFallback: false }; proof.status = 'INCOMPLETE'; }
    else if (proof.neighborHealthyBeforeCleanup) proof.status = 'PASS';
    await retain();
    assert.equal(failures.length, 0, 'controlled fixture cleanup or freeze unconfirmed; original debt retained');
  };
  const start = async () => {
    try {
      await verify(); await noRuntime();
      child = spawn(fixture.node, [rootScript, fixture.root], { cwd: fixture.root, env: fixture.appEnvironment,
        detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', error => { proof.rootSpawnError = error.message; });
      child.stdin?.on('error', error => { proof.rootInputError = error.message; });
      const originalSource = native.captureRoot(child, () => !cleanupStarted); // Original handle, before first yield.
      child.stdout?.resume(); child.stderr?.on('data', (chunk: Buffer) => {
        proof.rootDiagnostics = (String(proof.rootDiagnostics ?? '') + chunk.toString()).slice(0, 8192);
      });
      const registrar = { backendId: profile.owner.ownerId, teamId: profile.teams[0]!.binding.teamId,
        runId: 'TEST-controlled-service-run', memberId: 'TEST-controlled-service-registrar', generation: '1' };
      let services: Awaited<ReturnType<typeof readProcessServices>> | undefined;
      await until(async () => { try { services = await readProcessServices(fixture.root); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false;
      } }, 10_000, 'two original service publications');
      assert.ok(services);
      await probeProcessService(services.primary); await probeProcessService(services.neighbor);
      neighborCapture = originalSource.capture(services.neighbor.pid, registrar);
      const lease = acquireProfileWriterLease(profile.owner.storageRoot);
      let registration: unknown;
      try {
        const team = profile.teams[0]!;
        const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding: team.binding, members: team.members, grants: team.grants });
        const commands = owner.processCommands(profile.principalId, { assertCurrent: lease.assertCurrent,
          registrar: () => registrar, native: { capture: (pid, binding) => originalSource.capture(pid, binding), observe: native.observe, signal: native.signal } });
        registration = commands.register('TEST-controlled-process-register-original', { pid: services.primary.pid, label: PROCESS_LABEL,
          port: services.primary.port, url: services.primary.url, command: 'TEST finite controlled original service' });
        original = row(commands.list()[0]); assert.equal(original.observation, 'same-live'); assert.equal(original.canTerminate, true);
      } finally { lease.release(); }
      const canonical = createControllerProcessPolicy(registry).readStrict(); assert.equal(canonical.length, 1);
      primaryCapture = canonical[0]!.capturedNative; assert.ok(primaryCapture);
      rootCapture = { ...structuredClone(primaryCapture), target: structuredClone(primaryCapture.root) };
      registrySha256 = await fileDigest(registry);
      Object.assign(proof, { registration, original, originalProcessRef: original!.processRef, canonicalPrimary: canonical[0], rootCapture, neighborCapture, services });
      hostA = startHost({ node: fixture.node, entry: fixture.hostEntry, root: fixture.root,
        profile: fixture.profilePath, profileHash: fixture.pins.profileSha256 });
      await hostA.rpc('host.handshake', { protocolVersion: 1 });
      const listed = await hostA.rpc('team.process.list', { commandId: 'TEST-controlled-first-host-list',
        binding: { schemaVersion: 1, handleId: fixture.handleId, owner: profile.owner, scope: profile.teams[0]!.scope }, payload: {} });
      assert.equal(listed.ok, true); assert.deepEqual(listed.value, [original]);
      await closeHost(); await noRuntime(); await verify();
      await writeFile(join(fixture.root, source.recordFile), JSON.stringify({ ...proof, registry: { path: registry, sha256: registrySha256 } }, null, 2), { mode: 0o600, flag: 'wx' });
      await retain();
    } catch (error) {
      proof.failure = error instanceof Error ? error.message : String(error);
      try { await cleanup(); } catch (cleanupError) { proof.cleanupFailure = String(cleanupError); await retain(); }
      throw error;
    }
  };
  return { ...fixture, controlledProcess: { proof, source, start, cleanup, verify } };
}
