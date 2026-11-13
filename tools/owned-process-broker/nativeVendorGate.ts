import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createWindowsOwnedLaunchPort, OwnedProcessFacade } from '@agent-teams/legacy-agent-host/owned-process';
import type { PendingOwnedProcess, PreparedOwnedProcess, ProcessOwner } from '@agent-teams/legacy-agent-host/owned-process';
import { windowsLaunchSpec } from '../../packages/legacy-agent-host/dist/adapters/providers/WindowsCapturedProcess.js';
import { runNativeWindowsClaude } from '../../packages/legacy-agent-host/tests/fixtures/native-windows-claude.ts';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import { brokerReleased, capturedWitness, timeout, waitFor } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';
import { createFixtureOutputCollector } from './nativeGateOutput';
import { nativeVendorBroker } from './nativeVendorBroker';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
interface Selection {
  schemaVersion: number; testOnly: boolean; platform: string; version: string; integrity: string;
  executable: { path: string; sha256: string }; bash: { path: string; sha256: string };
}
export async function runNativeVendorGate(debugBroker: string, fixture: string,
  selectionPath: string, selectionSha256: string, receiptPath: string, sandbox: string): Promise<void> {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
  assert.equal(process.platform, 'win32');
  assert.equal(process.version, 'v24.21.0');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.match(process.env.EXPECTED_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.ok(resolve(sandbox).startsWith(resolve(tmpdir()) + sep) && /^opg[0-9a-f]+\.tmp$/i.test(basename(sandbox)),
    'Only the original independent controller creates this TEST sandbox');
  assert.ok(isAbsolute(receiptPath) && !existsSync(receiptPath));
  assert.match(selectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(selectionPath), selectionSha256);
  const selected = JSON.parse(readFileSync(selectionPath, 'utf8')) as Selection;
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.testOnly, true);
  assert.equal(selected.platform, 'win32-' + process.arch); assert.equal(selected.version, '0.3.305');
  assert.equal(realpathSync(selected.executable.path), selected.executable.path);
  assert.equal(realpathSync(selected.bash.path), selected.bash.path);
  assert.match(basename(debugBroker), /^owned-process-broker-debug-service\.exe$/);
  for (const path of [debugBroker, fixture, selected.executable.path])
    verifyBrokerArchitecture(readFileSync(path), process.arch);
  const digests = { broker: hash(debugBroker), fixture: hash(fixture), node: hash(process.execPath),
    claude: selected.executable.sha256, bash: selected.bash.sha256, selection: selectionSha256 };
  const verify = () => {
    assert.equal(hash(debugBroker), digests.broker); assert.equal(hash(fixture), digests.fixture);
    assert.equal(hash(selected.executable.path), digests.claude); assert.equal(hash(selected.bash.path), digests.bash);
    assert.equal(hash(selectionPath), digests.selection);
  };
  verify();
  const events = createNativeGateEvents(), nonce = randomUUID();
  const children = new Set<ChildProcess>(), exits = new Map<ChildProcess, Promise<void>>();
  const track = (child: ChildProcess) => {
    children.add(child);
    const done = new Promise<void>((resolveExit, reject) => {
      child.once('exit', () => resolveExit()); child.once('error', reject);
    });
    void done.catch(() => undefined); exits.set(child, done);
  };
  const identity: ProcessOwner = { teamIncarnation: nonce, runId: nonce, laneId: 'TEST-native-vendor',
    processGeneration: randomUUID() };
  const tap = nativeVendorBroker({ path: debugBroker, diagnosticPath: join(sandbox, 'debug-failure.bin'),
    owner: identity, events, verify, track });
  const port = createWindowsOwnedLaunchPort(debugBroker, 'job-membership', tap.factory);
  let pending: PendingOwnedProcess | undefined, prepared: PreparedOwnedProcess | undefined;
  let facade: OwnedProcessFacade | undefined, stopping: Promise<boolean> | undefined;
  let cleanupProof = false, launched = 0, installedBeforeInput = false;
  const phase = (value: string) => console.log(JSON.stringify({ nativeVendorPhase: value }));
  const stop = () => stopping ??= (async () => {
    if (!pending) return true;
    phase('whole-provider-stop');
    const outcome = await pending.stop({ expectedOwner: identity,
      attemptId: 'TEST-vendor-final-cleanup', mode: 'force', deadlineMs: performance.now() + 10000 });
    assert.equal(outcome.kind, 'confirmed');
    if (outcome.kind !== 'confirmed') return false;
    if (prepared) assert.equal((await prepared.drain(performance.now() + 3000)).kind, 'complete');
    await pending.release(outcome.receipt, 'job-membership');
    await brokerReleased(pending, events);
    cleanupProof = true;
    return true;
  })();
  const marker = join(sandbox, 'native-service.started'), outputPath = join(sandbox, 'native-service.jsonl');
  const witnesses: Awaited<ReturnType<typeof capturedWitness>>[] = [];
  let nativeProof: Awaited<ReturnType<typeof runNativeWindowsClaude>> | undefined;
  let scopedProof: Awaited<ReturnType<typeof tap.stopService>> | undefined;
  let originalFailure: unknown, passed = false, cleanup = false;
  const cleanupErrors: unknown[] = [];
  phase('sentinel');
  const sentinel = spawn(fixture, ['vendor-sentinel'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  track(sentinel);
  try {
    await timeout(events.wait(new Promise<void>(done =>
      sentinel.stdout!.once('data', events.guard(() => done())))));
    phase('actual-sdk-open');
    nativeProof = await runNativeWindowsClaude({ root: sandbox,
      executable: selected.executable.path, bash: selected.bash.path, fixture, marker, output: outputPath, nonce,
      custody: {
        launch(request) {
          assert.equal(launched++, 0, 'One original native session; no invisible SDK restart');
          assert.equal(request.command, selected.executable.path);
          assert.equal(request.cwd, join(sandbox, 'workspace'));
          const environment: Record<string, string> = {};
          for (const [key, value] of Object.entries(request.env ?? {})) {
            assert.ok(typeof value === 'string'); environment[key] = value;
          }
          verify();
          const spec = windowsLaunchSpec({ cwd: request.cwd,
            executable: selected.executable, environment }, request.args);
          pending = port.allocate(identity); // Original cleanup capability retained before any await.
          const allocation = pending;
          facade = new OwnedProcessFacade({ owner: identity, current: () => stopping === undefined,
            prepare: () => port.prepare(allocation, spec),
            installOwner: async process => {
              assert.equal(prepared, undefined); prepared = process;
              assert.equal(process.owner, allocation.owner);
              installedBeforeInput = true; // The real facade invokes this inside prepared.resume.
            },
            requestStop: () => { void stop().catch(() => undefined); return true; },
            ...(request.signal ? { signal: request.signal } : {}) });
          facade.stderr.resume();
          return facade;
        },
        confirmStopped: stop,
      },
      async afterBackground() {
        phase('native-background-ready');
        assert.ok(facade && prepared && installedBeforeInput);
        assert.equal(facade.pid, prepared.root.pid);
        const output = createFixtureOutputCollector();
        let readBytes = 0;
        await waitFor(() => {
          if (!existsSync(outputPath)) return false;
          const bytes = readFileSync(outputPath);
          assert.ok(bytes.length >= readBytes && bytes.length <= 65536);
          output.push(bytes.subarray(readBytes)); readBytes = bytes.length;
          return output.root !== undefined && output.children.length === 4;
        }, 10000, events);
        assert.equal(readFileSync(marker, 'utf8'), nonce, 'Real native Bash executed the controlled fixture');
        const [service, neighbor] = output.childrenOf(output.root!.pid);
        assert.ok(service && neighbor);
        const descendants = output.childrenOf(service.pid);
        assert.equal(descendants.length, 2);
        phase('capture-original-witnesses');
        const observed = [prepared.root, output.root!, service, ...descendants, neighbor];
        witnesses.push(...await events.wait(Promise.all(observed.map(original =>
          capturedWitness(fixture, original.pid, original.birth, track, events, 'vendor-wait-gated')))));
        const [providerWitness, backgroundWitness, serviceWitness, firstLeaf, secondLeaf, adjacent] = witnesses;
        assert.ok(providerWitness && backgroundWitness && serviceWitness && firstLeaf && secondLeaf && adjacent);
        phase('scoped-original-job-stop');
        scopedProof = await tap.stopService(service);
        assert.deepEqual(await timeout(events.wait(Promise.all(
          [serviceWitness, firstLeaf, secondLeaf].map(witness => witness.exit)))), [0, 0, 0]);
        assert.equal(providerWitness.process.exitCode, null);
        assert.equal(backgroundWitness.process.exitCode, null);
        assert.equal(adjacent.process.exitCode, null);
        assert.equal(sentinel.exitCode, null);
        assert.equal(facade.exitCode, null);
        assert.equal(cleanupProof, false, 'Service Stop cannot mint a provider cleanup receipt');
        phase('same-native-session-continuation');
      },
    });
    assert.equal(launched, 1); assert.equal(nativeProof.cleanup, true);
    assert.deepEqual(nativeProof.failures, []);
    assert.equal(cleanupProof, true);
    assert.deepEqual(await timeout(events.wait(Promise.all(witnesses.map(witness => witness.exit)))), [0, 0, 0, 0, 0, 0]);
    assert.equal(sentinel.exitCode, null, 'Unrelated original process survived both scoped and provider Stop');
    verify(); assert.equal(hash(process.execPath), digests.node);
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    try { assert.equal(await stop(), true); } catch (error) { cleanupErrors.push(error); }
    // Exact ChildProcess objects created here only; the native controller independently
    // proves outer Job zero. Emergency cleanup is always a failed controller result.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    try { await timeout(Promise.all(exits.values()), 10000); await events.wait(Promise.resolve()); }
    catch (error) { cleanupErrors.push(error); }
    cleanup = cleanupErrors.length === 0 && (pending === undefined || cleanupProof);
    writeFileSync(receiptPath, JSON.stringify({ kind: 'TEST_WINDOWS_NATIVE_CLAUDE_SERVICE_SCOPE',
      sourceHead: process.env.EXPECTED_SOURCE_SHA, platform: 'win32-' + process.arch, nodeVersion: process.version,
      status: passed && cleanup && originalFailure === undefined ? 'PASS' : 'INCOMPLETE',
      digests, nativePackageVersion: selected.version, officialArchiveIntegrity: selected.integrity,
      nativeRequests: nativeProof?.requests ?? [], nativeFailures: nativeProof?.failures ?? [],
      oneOriginalSession: launched === 1, installedBeforeInput, scopedProof, cleanup,
      originalProviderJobReleased: cleanupProof,
      vendorAuthQualified: false, registryQualified: false, coldOwnerQualified: false,
      desktopQualified: false, releaseQualified: false }, null, 2) + '\n', { flag: 'wx' });
  }
  if (originalFailure !== undefined || cleanupErrors.length)
    throw new AggregateError([...(originalFailure === undefined ? [] : [originalFailure]), ...cleanupErrors],
      'Native Windows vendor gate failed; original evidence retained');
  assert.ok(passed && cleanup);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [debugBroker, fixture, selection, sha256, receipt, flag, sandbox] = process.argv.slice(2);
  assert.ok(debugBroker && fixture && selection && sha256 && receipt && sandbox);
  assert.equal(flag, '--controller-sandbox');
  await runNativeVendorGate(realpathSync(debugBroker), realpathSync(fixture), realpathSync(selection),
    sha256, resolve(receipt), realpathSync(sandbox));
}
