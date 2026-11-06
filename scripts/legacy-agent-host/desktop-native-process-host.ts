import { fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHost } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { TEAM_HOST_DISPOSE_TIMEOUT_MS } from '../../packages/legacy-agent-host/src/contracts.ts';
import { createProcessCustody } from '../../packages/legacy-agent-host/dist/composition/processCustody.js';
import { createControllerProcessPolicy } from '../../packages/legacy-agent-host/dist/process/ControllerProcessPolicy.js';
import type {
  RegisteredProcessCapture,
  ProcessObservation,
} from '../../packages/legacy-agent-host/dist/process/registeredProcessContracts.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import {
  PROCESS_BOOTSTRAP,
  PROCESS_LABEL,
  PROCESS_REGISTER_ID,
  qualifyNativeServiceCompletion,
} from './desktop-native-process-model.ts';
import type { startProcessModel } from './desktop-native-process-model.ts';
import {
  assertProcessFixture,
  probeProcessService,
  readProcessServices,
} from './desktop-native-process-fixture.ts';
import type { ProcessFixture } from './desktop-native-process-fixture.ts';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Shared original launch/input/registration; no crash, stop, replay or recapture. */
async function qualifyOriginalNativeRegistration(
  fixture: ProcessFixture,
  model: Awaited<ReturnType<typeof startProcessModel>>,
  host: ReturnType<typeof startHost>,
  profile: TeamHostProfile,
  envelope: (commandId: string, payload: unknown) => unknown
) {
  const handshake = await host.rpc('host.handshake', { protocolVersion: 1 });
  for (const capability of ['team.process.list', 'team.process.terminate', 'team.process.lookup'])
    assert.ok((handshake.capabilities as string[]).includes(capability));
  const before = await host.rpc('team.launch.read', envelope('TEST-process-launch-read', {}));
  assert.equal(before.ok, true);
  const launch = row(before.value);
  const started = await host.rpc(
    'team.launch.start',
    envelope('TEST-process-original-launch', {
      launchId: launch.launchId,
      rosterRevision: launch.rosterRevision,
      configuration: {
        members: [
          {
            memberId: 'alice-id',
            model: 'claude-sonnet-4-6',
            effort: 'low',
            fastMode: false,
            permissions: 'bypass',
            context: 'model-default',
          },
        ],
      },
    })
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const state = await host.rpc(
      'runtime.read',
      envelope('TEST-process-ready-read', { memberId: 'alice-id' })
    );
    assert.equal(state.ok, true);
    if (row(state.value).nativeReady === true) {
      ready = true;
      break;
    }
    await delay(25);
  }
  assert.equal(ready, true, 'actual native private MCP discovery');
  const input = await host.rpc(
    'team.execute',
    envelope('TEST-process-bootstrap-input', {
      operation: 'message.send',
      payload: {
        to: 'alice',
        text: PROCESS_BOOTSTRAP,
        summary: 'One TEST native process registration',
        messageId: 'TEST-process-bootstrap-input',
        actionMode: 'do',
      },
    })
  );
  assert.equal(input.ok, true);
  const inputId = row(row(input.value).effects).deliveryId;
  assert.equal(typeof inputId, 'string');
  let terminal = false;
  const inputEnd = Date.now() + 90_000;
  while (Date.now() < inputEnd) {
    assert.deepEqual(model.failures, []);
    const state = await host.rpc(
      'runtime.read',
      envelope('TEST-process-terminal-read', { memberId: 'alice-id' })
    );
    assert.equal(state.ok, true);
    const selected = (row(state.value).inputs as unknown[])
      .map(row)
      .find((r) => r.inputId === inputId);
    if (selected?.phase === 'terminal') {
      assert.equal(selected.terminal, 'succeeded');
      terminal = true;
      break;
    }
    await delay(25);
  }
  assert.equal(terminal, true, 'only original native input reaches terminal');
  assert.equal(model.observations.length, 4);
  assert.deepEqual(model.failures, []);
  const inventory = await host.rpc(
    'team.process.list',
    envelope('TEST-process-before-crash-list', {})
  );
  assert.equal(inventory.ok, true);
  assert.ok(Array.isArray(inventory.value));
  const processes = (inventory.value as unknown[]).map(row);
  assert.equal(processes.length, 1);
  const original = processes[0]!;
  assert.equal(original.label, PROCESS_LABEL);
  assert.equal(original.canTerminate, true);
  assert.equal(original.observation, 'same-live');
  const services = await readProcessServices(fixture.root);
  assert.equal(original.pid, services.primary.pid);
  await probeProcessService(services.primary);
  await probeProcessService(services.neighbor);
  const processesPath = join(
    profile.owner.storageRoot,
    'teams',
    profile.teams[0]!.binding.teamName,
    'processes.json'
  );
  const registrySha256 = await fileDigest(processesPath);
  const canonical = createControllerProcessPolicy(processesPath).readStrict();
  assert.equal(await fileDigest(processesPath), registrySha256);
  assert.equal(canonical.length, 1);
  const primary = canonical[0]!;
  assert.equal(primary.id, original.id);
  assert.equal(primary.pid, services.primary.pid);
  assert.equal(primary.label, PROCESS_LABEL);
  assert.equal(primary.capturedByCommand, PROCESS_REGISTER_ID);
  assert.ok(primary.capturedNative, 'canonical original registration supplies root identity');
  // Only the original immutable root is projected into the observation target slot.
  // No captureRoot/capture/signal call, PID selection, or replacement-root adoption.
  const rootCapture: RegisteredProcessCapture = {
    ...structuredClone(primary.capturedNative),
    target: structuredClone(primary.capturedNative.root),
  };
  const custody = createProcessCustody(profile.processCustody);
  assert.ok(custody);
  assert.equal(custody.observe(rootCapture), 'same-live', 'original root oracle before crash');
  const oraclePaths = [
    'scripts/legacy-agent-host/desktop-native-process-host.ts',
    'packages/legacy-agent-host/src/process/DarwinRegisteredProcess.ts',
    'packages/legacy-agent-host/dist/process/DarwinRegisteredProcess.js',
    'packages/legacy-agent-host/dist/composition/processCustody.js',
  ];
  assert.ok(profile.processCustody);
  const sourceOracle = await Promise.all(
    [
      ...oraclePaths.map((path) => resolve(import.meta.dirname, '../..', path)),
      ...['manifest.json', 'registered-process.node', 'registered-process-darwin.c'].map((name) =>
        join(profile.processCustody!.directory, name)
      ),
    ].map(async (path) => ({ path, sha256: await fileDigest(path) }))
  );
  const beforeCrash = {
    original,
    canonicalPrimary: primary,
    rootCapture,
    registry: { path: processesPath, sha256: registrySha256 },
    sourceOracle,
    processCustody: profile.processCustody,
    services,
    inputId,
    handshake,
    launch: started.value,
    host: host.facts(),
    model: model.observations,
    rawModelTurns: model.rawTurns,
    originalBackgroundTasks: model.backgroundTasks,
    notificationAcksBeforeCrash: structuredClone(model.notificationAcks),
  };
  return { receipt: beforeCrash, custody };
}

/** Explicit Root GO must include the intentional crash of this original owned Host ChildProcess. */
export async function qualifyNativeRegistrationThenCrash(
  fixture: ProcessFixture,
  model: Awaited<ReturnType<typeof startProcessModel>>,
  go: { nativeClaude: true; crashOriginalHost: true }
) {
  assert.equal(go.nativeClaude, true);
  assert.equal(go.crashOriginalHost, true);
  assert.equal(process.env.LEGACY_M19_PROVIDER_UI_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, '1');
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  const binding = {
    schemaVersion: 1,
    handleId: fixture.handleId,
    owner: profile.owner,
    scope: profile.teams[0]!.scope,
  };
  const envelope = (commandId: string, payload: unknown) => ({
    commandId,
    binding,
    payload,
  });
  await writeFile(
    join(fixture.root, 'native-process-launch-intent.json'),
    JSON.stringify(
      {
        profileSha256: fixture.pins.profileSha256,
        messageCommandId: 'TEST-process-bootstrap-input',
        registerCommandId: PROCESS_REGISTER_ID,
        boundedActions: [
          'original launch',
          'two foreground finite native background Bash tasks',
          'one actual member MCP registration',
          'one original Host ChildProcess SIGKILL',
        ],
      },
      null,
      2
    ),
    { mode: 0o600, flag: 'wx' }
  );
  const diagnostics: string[] = [];
  const host = startHost({
    node: fixture.node,
    entry: fixture.hostEntry,
    root: fixture.root,
    profile: fixture.profilePath,
    profileHash: fixture.pins.profileSha256,
    onDiagnostic(chunk) {
      if (diagnostics.join('').length < 2_000_000) diagnostics.push(chunk.toString());
    },
  });
  let crashed = false;
  try {
    const { receipt: beforeCrash, custody } = await qualifyOriginalNativeRegistration(
      fixture, model, host, profile, envelope
    );
    const { inputId, rootCapture, sourceOracle, canonicalPrimary: primary } = beforeCrash;
    assert.ok(primary.capturedNative);
    await writeFile(
      join(fixture.root, 'native-process-before-crash.json'),
      JSON.stringify(beforeCrash, null, 2),
      { mode: 0o600, flag: 'wx' }
    );
    // This is intentionally NOT normal provider cleanup. Runtime native custody may remain HOLD.
    await writeFile(
      join(fixture.root, 'original-host-crash-requested.json'),
      JSON.stringify({
        originalHostPid: host.child.pid,
        operation: 'original ChildProcess.kill',
        signal: 'SIGKILL',
        afterNativeInputTerminal: inputId,
      }),
      { mode: 0o600, flag: 'wx' }
    );
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((done) => host.child.once('exit', (code, signal) => done({ code, signal })));
    assert.equal(
      host.child.kill('SIGKILL'),
      true,
      'only the original held ChildProcess; never a recaptured PID'
    );
    crashed = true;
    const result = await Promise.race([
      exit,
      delay(10_000).then(() => {
        throw new Error('Original Host crash outcome unknown; do not replay');
      }),
    ]);
    assert.equal(result.signal, 'SIGKILL');
    await writeFile(
      join(fixture.root, 'original-host-crash-result.json'),
      JSON.stringify({
        ...result,
        facts: host.facts(),
        nativeCleanupClaim: false,
      }),
      { mode: 0o600, flag: 'wx' }
    );
    // TEST-only finite observation budget matches this helper's native-ready/input budgets.
    // Logical Runtime custody stays HOLD even when physical original-root absence is proven.
    const budgetMs = 60_000,
      intervalMs = 250,
      startedAt = Date.now();
    const observationsPath = join(fixture.root, 'original-native-root-observations.ndjson');
    await writeFile(observationsPath, '', { mode: 0o600, flag: 'wx' });
    let observation: ProcessObservation = 'unknown',
      samples = 0;
    do {
      observation = custody.observe(rootCapture);
      await appendFile(
        observationsPath,
        JSON.stringify({
          phase: 'after-original-host-SIGKILL-before-UI',
          sequence: ++samples,
          elapsedMs: Date.now() - startedAt,
          observedAt: new Date().toISOString(),
          observation,
        }) + '\n'
      );
      if (observation === 'absent' || Date.now() - startedAt >= budgetMs) break;
      await delay(Math.min(intervalMs, budgetMs - (Date.now() - startedAt)));
    } while (Date.now() - startedAt < budgetMs);
    const rootObservation = {
      status: observation === 'absent' ? 'PHYSICAL_ABSENCE_OBSERVED' : 'INCOMPLETE',
      phase: 'after-original-host-SIGKILL-before-UI',
      originalCapture: rootCapture,
      sourceOracle,
      budgetMs,
      intervalMs,
      samples,
      elapsedMs: Date.now() - startedAt,
      observation,
      runtimeCustody: 'HOLD',
      nativeCleanupClaim: false,
      signals: 0,
      recaptures: 0,
      adoptions: 0,
    };
    await writeFile(
      join(fixture.root, 'original-native-root-observation.json'),
      JSON.stringify(rootObservation, null, 2),
      { mode: 0o600, flag: 'wx' }
    );
    assert.equal(
      observation,
      'absent',
      'INCOMPLETE/HOLD: original native root absence unproven; no UI continuation or signal/replay'
    );
    // Cold reconciliation observes the exact original target. EOF may legitimately stop it;
    // survival is never a prerequisite or a reason to relaunch/recapture a replacement.
    const targetAfterRootExit = {
      originalCapture: primary.capturedNative,
      observation: custody.observe(primary.capturedNative),
      signals: 0,
      recaptures: 0,
      adoptions: 0,
      nativeCleanupClaim: false,
    };
    await writeFile(
      join(fixture.root, 'original-native-target-after-root-exit.json'),
      JSON.stringify(targetAfterRootExit, null, 2),
      { mode: 0o600, flag: 'wx' }
    );
    assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
    assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
    return { ...beforeCrash, rootObservation, targetAfterRootExit };
  } finally {
    await writeFile(
      join(fixture.root, 'native-process-host-diagnostics.log'),
      diagnostics.join(''),
      { mode: 0o600, flag: 'wx' }
    );
    // If the intentional crash was not attempted, use only the original normal Host handle.
    if (!crashed) await host.close();
  }
}

/** EOF only. The shared Host helper's signal fallback is unreachable after this original exit. */
async function closeOriginalProcessHost(host: ReturnType<typeof startHost>) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    const originalExit = new Promise<void>((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        host.child.off('exit', onExit);
        reject(new Error('Original Host EOF close unconfirmed; retain HOLD without a signal'));
      }, TEAM_HOST_DISPOSE_TIMEOUT_MS + 2_000);
      host.child.once('exit', onExit);
    });
    host.child.stdin.end();
    await originalExit;
  }
  assert.equal(host.child.exitCode, 0);
  assert.equal(host.child.signalCode, null);
  await host.close();
}

/** Fresh TEST normal Stop only. This never calls the historical intentional-crash wrapper. */
export async function qualifyNativeRegistrationThenStop(
  fixture: ProcessFixture,
  model: Awaited<ReturnType<typeof startProcessModel>>,
  go: { nativeClaude: true; normalStop: true }
) {
  assert.equal(go.nativeClaude, true);
  assert.equal(go.normalStop, true);
  assert.equal(process.env.LEGACY_PROCESS_NORMAL_SDK_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined);
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  const binding = { schemaVersion: 1, handleId: fixture.handleId, owner: profile.owner,
    scope: profile.teams[0]!.scope };
  const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
  const stopCommandId = 'TEST-native-normal-human-stop-original';
  const proof: Record<string, unknown> = { schemaVersion: 1, status: 'INCOMPLETE',
    scope: 'Fresh original SDK registration, one Human terminate, normal Runtime/Host close',
    original911Unchanged: true, harnessSignals: 0, recaptures: 0, adoptions: 0,
    stopCommandId, profileSha256: fixture.pins.profileSha256 };
  const retain = () => writeFile(join(fixture.root, 'normal-native-process-receipt.json'),
    JSON.stringify(proof, null, 2), { mode: 0o600 });
  await writeFile(join(fixture.root, 'normal-native-process-receipt.json'), JSON.stringify(proof),
    { mode: 0o600, flag: 'wx' });
  const diagnostics: string[] = [];
  const host = startHost({ node: fixture.node, entry: fixture.hostEntry, root: fixture.root,
    profile: fixture.profilePath, profileHash: fixture.pins.profileSha256,
    onDiagnostic(chunk) { if (diagnostics.join('').length < 2_000_000) diagnostics.push(chunk.toString()); } });
  let closeAttempted = false;
  const close = async () => {
    if (closeAttempted) return;
    closeAttempted = true;
    proof.ownerClose = 'EOF requested; not yet observed'; await retain();
    await closeOriginalProcessHost(host);
    proof.ownerClose = 'original Host exit0/no signal';
  };
  const lifecycle = async (role: 'primary' | 'neighbor') => {
    const text = await readFile(join(fixture.root, `workspace/process-${role}-lifecycle.ndjson`), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean); assert.ok(lines.length <= 3);
    return lines.map(line => row(JSON.parse(line)));
  };
  const wait = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 30_000;
    do { if (await check()) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Original normal process observation exhausted: ${label}; no replay`);
  };
  let failure: unknown;
  try {
    const original = await qualifyOriginalNativeRegistration(fixture, model, host, profile, envelope);
    const { receipt: before, custody } = original;
    proof.original = before; await retain();
    await writeFile(join(fixture.root, 'native-process-before-normal-stop.json'),
      JSON.stringify(before, null, 2), { mode: 0o600, flag: 'wx' });
    assert.match(String(before.original.processRef), /^p1:/);
    proof.stage = 'one original Human terminate'; await retain();
    const requested = await host.rpc('team.process.terminate',
      envelope(stopCommandId, { processRef: before.original.processRef }));
    assert.equal(requested.ok, true); proof.terminate = requested;
    let terminal = row(requested.value);
    proof.lastStopObservation = terminal;
    await wait(async () => {
      const state = row(terminal.state);
      if (terminal.phase === 'completed' && state.phase === 'completed' &&
        state.native === 'observed-absent' && state.signalAccepted === true) return true;
      const looked = await host.rpc('team.process.lookup', envelope('TEST-native-normal-stop-read',
        { originalCommandId: stopCommandId }));
      assert.equal(looked.ok, true); terminal = row(looked.value);
      proof.lastStopObservation = terminal; return false;
    }, 'same command completed with observed absence');
    assert.equal(terminal.commandId, stopCommandId);
    proof.stopReceipt = terminal;
    assert.ok(before.canonicalPrimary.capturedNative);
    assert.equal(custody.observe(before.canonicalPrimary.capturedNative), 'absent');
    await wait(async () => (await lifecycle('primary')).some(event => event.event === 'closed'),
      'original primary lifecycle closed');
    const primaryLifecycle = await lifecycle('primary');
    const primary = qualifyNativeServiceCompletion('primary', before.services.primary, primaryLifecycle);
    assert.equal(primary.exitReason, 'SIGTERM', 'natural TTL never proves the requested Stop');
    proof.primaryLifecycle = primaryLifecycle;
    await wait(async () => model.notificationAcks.some(ack => ack.role === 'primary' && ack.responseFinished),
      'bounded text-only original completion acknowledgement');
    await probeProcessService(before.services.neighbor);
    proof.neighborHealthyBeforeOwnerStop = true;
    const stopped = await host.rpc('runtime.stop', envelope('TEST-native-normal-owner-stop',
      { memberId: 'alice-id' }));
    assert.equal(stopped.ok, true);
    const runtime = row(stopped.value);
    assert.equal(runtime.phase, 'closed'); assert.equal(runtime.custody, 'released');
    proof.runtime = runtime;
    await close();
    await wait(async () => custody.observe(before.rootCapture) === 'absent', 'original SDK root absent');
    await wait(async () => (await lifecycle('neighbor')).some(event => event.event === 'closed'),
      'original neighbor lifecycle closed during owner cleanup');
    const neighborLifecycle = await lifecycle('neighbor');
    const neighbor = qualifyNativeServiceCompletion('neighbor', before.services.neighbor, neighborLifecycle);
    assert.equal(neighbor.exitReason, 'SIGTERM', 'neighbor TTL is not proof of owner cleanup');
    proof.neighborLifecycle = neighborLifecycle;
    proof.originalRootObservation = custody.observe(before.rootCapture);
    proof.originalTargetObservation = custody.observe(before.canonicalPrimary.capturedNative);
    const rows = createControllerProcessPolicy(before.registry.path).readStrict();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, before.canonicalPrimary.id);
    assert.deepEqual(rows[0]!.capturedNative, before.canonicalPrimary.capturedNative);
    assert.equal(model.observations.length, 4); assert.deepEqual(model.failures, []);
    assert.ok(model.notificationAcks.length <= 2 && model.notificationAcks.every(ack => ack.responseFinished));
    assert.equal(host.facts().frames.filter(frame => frame.method === 'team.process.terminate').length, 1);
    for (const pin of before.sourceOracle) assert.equal(await fileDigest(pin.path), pin.sha256);
    assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
    assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
    proof.model = model.observations; proof.notificationAcks = model.notificationAcks;
    proof.host = host.facts(); proof.status = 'NORMAL_SDK_PROCESS_STOP_OBSERVED';
  } catch (error) {
    failure = error; proof.failure = error instanceof Error ? error.message : String(error);
  } finally {
    try { await close(); } catch (error) {
      proof.ownerClose = { status: 'HOLD', failure: error instanceof Error ? error.message : String(error) };
      failure ??= error;
    }
    proof.host = host.facts();
    await writeFile(join(fixture.root, 'normal-native-process-host-diagnostics.log'), diagnostics.join(''),
      { mode: 0o600, flag: 'wx' });
    await retain();
  }
  if (failure) throw failure;
  return proof;
}

/** Existing harness pre-spawn boundary; failures retain the original prepared receipt. */
export async function qualifyPreparedProcessRegistration(options: {
  enabled: boolean;
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  model: Awaited<ReturnType<typeof startProcessModel>> | undefined;
  evidence: Record<string, unknown>;
  receiptPath: string;
  verifySourceFreeze(): Promise<void>;
}) {
  if (!options.enabled) return;
  const { fixture, model, evidence, receiptPath } = options;
  assertProcessFixture(fixture);
  assert.ok(model, 'same original process model');
  evidence.nativeProcessRuntimeCustody = {
    status: 'HOLD',
    nativeCleanupClaim: false,
    reason:
      'Intentional original Host crash is not provider cleanup; physical root observation is separate from logical SDK custody, never PID/group signals or adoption',
  };
  evidence.nativeProcessRootObservationPath = join(
    fixture.root,
    'original-native-root-observation.json'
  );
  try {
    evidence.nativeProcessRegistration = await qualifyNativeRegistrationThenCrash(fixture, model, {
      nativeClaude: true,
      crashOriginalHost: true,
    });
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  } catch (error) {
    evidence.nativeProcessRegistrationFailure =
      error instanceof Error ? error.message.slice(0, 4000) : 'qualification unavailable';
    await options.verifySourceFreeze();
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    throw error;
  }
}
