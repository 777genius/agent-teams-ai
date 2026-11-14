import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { createProcessMcpTools } from '../dist/mcp/processTools.js';
import type { WindowsServiceCapture, WindowsServiceOutcome } from '../dist/owned-process/retainedServiceContracts.js';
import { createTeamProcessCommands } from '../dist/process/TeamProcessCommands.js';
import { createTeamProcessMethods } from '../dist/process/createTeamProcessMethods.js';
import { processReceiptFingerprint, validateProcessReceipt } from '../dist/process/validateProcessRecords.js';
import { projectProcessReceipt } from '../dist/process/projectProcessViews.js';
import type {
  ProcessCommandReceipt,
  ProcessRegisterInput,
  WindowsProcessNative,
  RegisteredProcessCapture,
  TeamProcessRow,
} from '../dist/process/registeredProcessContracts.js';

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      : row
  );
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function fixture(ancestry: boolean | 'linux-warm' = false) {
  const files = new Map<string, unknown>();
  let rows: TeamProcessRow[] = [],
    signals = 0,
    lostAck = false,
    current = true,
    absent = false,
    unknown = false,
    captures = 0,
    corrupt = false,
    sourceCurrent = true,
    fenceDepth = 0,
    policyRegistrations = 0,
    interruptPolicy: 'register' | 'attach' | undefined;
  const registrar = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-member',
    generation: '1',
  };
  let capture: RegisteredProcessCapture = {
    version: 1,
    registrar,
    root: {
      auditToken: [501, 501, 20, 501, 20, 1000, 100, 2],
      sessionId: 1000,
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      osBuild: '24G90',
    },
    target: {
      auditToken: [501, 501, 20, 501, 20, 1001, 100, 3],
      sessionId: 1000,
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      osBuild: '24G90',
    },
  };
  if (ancestry === 'linux-warm') capture = {
    version: 4, platform: 'linux', admission: 'owner-pidfd-v1', registrar,
    ownerInstance: '11111111-1111-4111-8111-111111111111', captureKey: '22222222-2222-4222-8222-222222222222',
    root: { pid: 1000, sessionId: 1000, pidNamespaceId: '4026531836', bootId: capture.root.bootId },
    target: { pid: 1001, sessionId: 2000, pidNamespaceId: '4026531836', bootId: capture.root.bootId },
  };
  else if (ancestry) capture = {
    ...capture, version: 2, admission: 'live-ancestry-v1', target: { ...capture.target, sessionId: 2000 },
  };
  const options = {
    binding: { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'TEST-team' },
    principalId: 'TEST-human',
    digest,
    store: {
      fenced<T>(action: () => T) {
        fenceDepth++;
        try {
          const result = action();
          assert.ok(!(result instanceof Promise), 'TEST Team fence is synchronous');
          return result;
        } finally { fenceDepth--; }
      },
      read<T>(name: string) {
        return structuredClone(files.get(name)) as T | undefined;
      },
      write(name: string, value: unknown) {
        files.set(name, structuredClone(value));
      },
      list<T>() {
        return [...files.values()] as T[];
      },
    },
    authorize() {
      if (!current) throw new Error('process:forbidden');
      return { revision: 1, memberName: 'TEST-member' };
    },
    registrar() {
      return registrar;
    },
    assertCurrent() {
      if (!current) throw new Error('process:forbidden');
    },
    reserved() {
      return false;
    },
    invalidate() {},
    commandEntries() {
      return [...files.values()];
    },
    native: {
      capture() {
        captures++;
        return structuredClone(capture);
      },
      observe() {
        return unknown ? ('unknown' as const) : absent ? ('absent' as const) : ('same-live' as const);
      },
      signal() {
        signals++;
        if (lostAck) throw new Error('TEST lost result after request');
        return 'accepted' as const;
      },
    },
    registry: {
      readStrict() {
        if (corrupt) throw new Error('process:hold');
        return structuredClone(rows);
      },
      register(input: ProcessRegisterInput & { from: string }) {
        policyRegistrations++;
        const active = rows.find(row => row.pid === input.pid && !row.stoppedAt);
        const row = {
          id: active?.id ?? (policyRegistrations === 1 ? 'TEST-process' : 'TEST-process-' + policyRegistrations),
          pid: input.pid,
          label: input.label.trim(),
          registeredBy: input.from.trim(),
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.url?.trim() ? { url: input.url.trim() } : {}),
          ...(input.command?.trim() ? { command: input.command.trim() } : {}),
          registeredAt: '2026-10-23T00:00:00.000Z',
        };
        if (active) rows = rows.map(value => value.id === active.id ? row : value);
        else rows.push(row);
        if (interruptPolicy === 'register') throw new Error('TEST interrupted original registry write');
        return structuredClone(row);
      },
      attachOriginal(id: string, commandId: string, capture: RegisteredProcessCapture) {
        rows = rows.map((row) =>
          row.id === id ? { ...row, capturedNative: capture, capturedByCommand: commandId } : row
        );
        if (interruptPolicy === 'attach') throw new Error('TEST interrupted original attachment write');
        return structuredClone(rows.find((row) => row.id === id)!);
      },
      stopMetadata(selector: { id: string } | { pid: number }) {
        const id = rows.find(
          (row) =>
            ('id' in selector ? row.id === selector.id : row.pid === selector.pid) && !row.stoppedAt
        )?.id;
        rows = rows.map((row) =>
          row.id === id ? { ...row, stoppedAt: '2026-10-23T00:01:00.000Z' } : row
        );
        return structuredClone(rows.find((row) => row.id === id)!);
      },
      unregister(selector: { id: string } | { pid: number }) {
        rows = rows.filter((row) =>
          'id' in selector ? row.id !== selector.id : row.pid !== selector.pid
        );
        return structuredClone(rows);
      },
    },
  };
  const commands = createTeamProcessCommands(options);
  return {
    commands,
    cold: () => createTeamProcessCommands(options),
    windows: (windows: WindowsProcessNative, principalId = options.principalId) => {
      const { native: _native, ...withoutPosix } = options;
      return createTeamProcessCommands({ ...withoutPosix, principalId, windows,
        assertAsyncCurrent() {
          assert.equal(fenceDepth, 0, 'Full Runtime/source guard must stay outside Team fence');
          if (!sourceCurrent) throw new Error('process:forbidden');
        },
      });
    },
    fenceDepth: () => fenceDepth,
    policyRegistrations: () => policyRegistrations,
    interruptPolicy: (phase?: 'register' | 'attach') => { interruptPolicy = phase; },
    sourceChanged: () => { sourceCurrent = false; },
    restoreSource: () => { sourceCurrent = true; },
    coldUnavailable: () => {
      const { native: _native, ...coldOptions } = options;
      return createTeamProcessCommands(coldOptions);
    },
    rows: () => rows,
    signals: () => signals,
    captures: () => captures,
    unknown: () => { unknown = true; },
    lostAck: () => {
      lostAck = true;
    },
    absent: () => {
      unknown = false; absent = true;
    },
    corrupt: () => {
      corrupt = true;
    },
    revoke: () => {
      current = false;
    },
    files,
    replace: (value: TeamProcessRow[]) => {
      rows = value;
    },
  };
}
test('existing registry is cold-readable; metadata stop does not signal or claim native exit', () => {
  const f = fixture();
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST watcher' });
  const row = f.cold().list()[0]!;
  assert.equal(row.canTerminate, true);
  assert.equal(row.observation, 'same-live');
  assert.equal('capturedNative' in row, false);
  assert.equal('capturedByCommand' in row, false);
  const stopped = f.commands.metadata('TEST-metadata-stop', 'metadata-stop', {
    processRef: row.processRef,
  });
  assert.equal(stopped.state.native, 'not-requested');
  assert.equal(f.signals(), 0);
  assert.equal(f.commands.list()[0]!.observation, 'same-live');
  assert.equal(f.commands.list()[0]!.canTerminate, true); // Metadata stop cannot hide an owned live service.
  const original = f.commands.list()[0]!.processRef;
  assert.equal(f.commands.terminate('TEST-explicit-OS-stop', original).phase, 'held');
  assert.equal(f.signals(), 1);
  f.absent();
  assert.equal(f.commands.lookup('TEST-explicit-OS-stop')!.phase, 'completed');
});
test('requested-before-native survives lost result/cold reopen and never redispatches', () => {
  const f = fixture();
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST watcher' });
  const row = f.commands.list()[0]!;
  f.lostAck();
  const requested = f.commands.terminate('TEST-stop-original', row.processRef);
  assert.deepEqual(requested.state, { phase: 'requested', native: 'unknown' });
  assert.equal(f.signals(), 1);
  assert.equal(f.cold().list()[0]!.canTerminate, false);
  assert.equal(f.cold().pending()[0]!.commandId, 'TEST-stop-original');
  assert.throws(() => f.cold().terminate('TEST-stop-new-nonce', row.processRef), /hold/);
  assert.equal(f.signals(), 1);
  assert.equal(f.cold().terminate('TEST-stop-original', row.processRef).state.phase, 'requested');
  assert.equal(f.cold().lookup('TEST-stop-original')!.state.phase, 'requested');
  assert.equal(f.signals(), 1);
  f.absent();
  const completed = f.cold().lookup('TEST-stop-original')!;
  assert.deepEqual(completed.state, {
    phase: 'completed',
    native: 'observed-absent',
    signalAccepted: 'unknown',
  });
  assert.ok(f.rows()[0]!.stoppedAt);
  assert.equal(f.signals(), 1);
});
test('stale exact row, corrupt registry and revoked authority fail before any signal', () => {
  const f = fixture();
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST watcher' });
  const ref = f.commands.list()[0]!.processRef;
  f.replace(f.rows().map((row) => ({ ...row, label: 'TEST changed row' })));
  assert.throws(() => f.commands.terminate('TEST-stale', ref), /conflict/);
  assert.throws(
    () => f.commands.terminate('TEST-forged', f.commands.list()[0]!.processRef),
    /hold/
  );
  f.corrupt();
  assert.throws(() => f.commands.list(), /hold/);
  f.revoke();
  assert.throws(() => f.commands.terminate('TEST-revoked', ref), /forbidden/);
  assert.equal(f.signals(), 0);
});
test('finite Host route strips native authority and refuses PID or caller-supplied token selection', async () => {
  const f = fixture(),
    methods = createTeamProcessMethods({
      resolve: () => ({ commands: f.commands, assertCurrent() {} }),
    });
  const binding = { TEST: true },
    call = (method: string, commandId: string, payload: unknown) =>
      methods[`team.process.${method}`]!.handle({ binding, commandId, payload });
  await call('register', 'TEST-register', { pid: 1001, label: 'TEST watcher' });
  const listed = await call('list', 'TEST-list', {});
  assert.equal(JSON.stringify(listed).includes('auditToken'), false);
  assert.equal(JSON.stringify(listed).includes('capturedByCommand'), false);
  const result = (await call('terminate', 'TEST-unsafe', { pid: 1001, auditToken: [1] })) as {
    ok: boolean;
  };
  assert.equal(result.ok, false);
  assert.equal(f.signals(), 0);
});

test('metadata PID unregister preserves canonical all-history removal and never invokes OS signal', () => {
  const f = fixture();
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST watcher' });
  const active = f.rows()[0]!;
  f.replace([active, { ...active, id: 'TEST-old-history', stoppedAt: '2026-10-22T00:00:00.000Z' }]);
  const receipt = f.commands.metadata('TEST-unregister-all', 'unregister', { pid: 1001 });
  assert.equal(receipt.selected!.length, 2);
  assert.equal(receipt.phase, 'completed');
  assert.deepEqual(f.rows(), []);
  assert.equal(f.signals(), 0);
});
test('same existing command namespace validates original fingerprints and generic pending phases', () => {
  const f = fixture();
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST watcher' });
  const ref = f.commands.list()[0]!.processRef;
  f.lostAck();
  f.commands.terminate('TEST-stop', ref);
  const stopped = [...f.files.values()].find(
    (row) => (row as ProcessCommandReceipt).commandId === 'TEST-stop'
  ) as ProcessCommandReceipt;
  assert.equal(stopped.phase, 'held');
  assert.equal(stopped.state.phase, 'requested');
  stopped.original!.label = 'TEST corrupt retained original';
  assert.throws(() => f.cold().lookup('TEST-stop'), /hold/);
  assert.equal(f.signals(), 1);
});

test('explicit live-ancestry receipt cold-reads original target; same-token SID uncertainty holds custody without recapture or signal', () => {
  const f = fixture(true);
  const receipt = f.commands.register('TEST-live-ancestry-register', { pid: 1001, label: 'TEST foreground service' });
  assert.ok(receipt.capture?.version === 2);
  assert.equal(receipt.capture.target.sessionId, 2000);
  const cold = f.cold(), row = cold.list()[0]!;
  assert.equal(row.canTerminate, true);
  assert.ok(!JSON.stringify(row).includes('auditToken'));
  f.unknown(); // Native same-token SID drift is UNKNOWN, never stale/absence.
  assert.equal(cold.list()[0]!.observation, 'unknown');
  assert.equal(cold.list()[0]!.canTerminate, false);
  assert.throws(() => cold.terminate('TEST-no-SID-drift-stop', row.processRef), /hold/);
  assert.throws(() => cold.assertReleased(), /hold/);
  const original = cold.lookup('TEST-live-ancestry-register');
  assert.ok(original?.capture?.version === 2);
  assert.equal(original.capture.target.sessionId, 2000);
  assert.equal(f.captures(), 1, 'Cold lookup cannot expand admission using a fresh lineage walk');
  assert.equal(f.signals(), 0);
  f.absent(); cold.assertReleased();
});

test('cold warm history requires completed absence of the full original capture, never a signal or another owner', () => {
  const f = fixture('linux-warm');
  f.commands.register('TEST-register', { pid: 1001, label: 'TEST original service' });
  const row = f.commands.list()[0]!;
  f.commands.terminate('TEST-stop', row.processRef);
  const cold = f.coldUnavailable();
  assert.equal(cold.list()[0]!.observation, 'unknown');
  assert.equal(cold.lookup('TEST-stop')!.state.phase, 'requested');
  assert.throws(() => cold.assertReleased(), /hold/);
  f.commands.metadata('TEST-metadata', 'metadata-stop', { processRef: row.processRef });
  assert.equal(cold.list()[0]!.observation, 'unknown');
  f.absent();
  const completed = f.commands.lookup('TEST-stop')!;
  assert.equal(completed.state.native, 'observed-absent');
  assert.equal(cold.list()[0]!.observation, 'absent');
  assert.equal(cold.list()[0]!.canTerminate, false);
  cold.assertReleased();
  assert.ok(completed.capture?.version === 4 && completed.original);
  const foreign = structuredClone(completed);
  assert.ok(foreign.capture?.version === 4 && foreign.original);
  foreign.capture.ownerInstance = '33333333-3333-4333-8333-333333333333';
  foreign.original.capturedNative = structuredClone(foreign.capture);
  foreign.fingerprint = processReceiptFingerprint(foreign, digest);
  f.files.set('commands/' + digest('TEST-stop') + '.json', foreign);
  assert.equal(cold.list()[0]!.observation, 'unknown', 'Same PID and metadata cannot borrow another owner exit');
  assert.throws(() => cold.assertReleased(), /hold/);
  assert.equal(f.captures(), 1); assert.equal(f.signals(), 1);
});


/** Synthetic native port over the existing command store; this is not an OS qualification. */
function windowsFixture() {
  const f = fixture();
  const capture: WindowsServiceCapture = {
    version: 5, platform: 'win32', admission: 'main-owned-job-scope-v1',
    mainEpoch: 'TEST-main', providerCapability: 'TEST-provider',
    providerGeneration: '11111111-1111-4111-8111-111111111111',
    root: { pid: 1000, birth: '0000000000000010' },
    target: { pid: 1001, key: '0000000000000001', birth: '0000000000000011' },
    registrar: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
      memberId: 'TEST-member', generation: '1' },
  };
  const source = () => ({ mainEpoch: capture.mainEpoch, providerCapability: capture.providerCapability,
    providerGeneration: capture.providerGeneration, root: structuredClone(capture.root) });
  const replies = new Map<string, WindowsServiceOutcome>();
  let sequence = 0, captures = 0, stops = 0, settlements = 0, absent = false, loseCapture = false;
  let pause: 'run' | 'lookup' | 'query' | 'admission' | undefined;
  let captureReply: WindowsServiceOutcome | undefined;
  let settlementReply: WindowsServiceOutcome | undefined, lastSettlement: string | undefined;
  let pending: { finish(value?: WindowsServiceOutcome): void } | undefined;
  const holdReply = (kind: 'run' | 'lookup' | 'query' | 'admission', value: WindowsServiceOutcome) => {
    if (pause !== kind) return Promise.resolve(structuredClone(value));
    pause = undefined;
    return new Promise<WindowsServiceOutcome>(resolve => {
      pending = { finish: replacement => { pending = undefined; resolve(structuredClone(replacement ?? value)); } };
    });
  };
  const port: WindowsProcessNative = {
    prepareCapture(pid, registrar) {
      assert.ok(f.fenceDepth() > 0, 'Pure intent is minted under original Team admission');
      assert.equal(pid, capture.target.pid); assert.deepEqual(registrar, capture.registrar);
      return { ...source(), operationRef: 'TEST-service-' + ++sequence,
        command: { operation: 'capture', pid, registrar: structuredClone(registrar) } };
    },
    prepareControl(selected, operation) {
      assert.ok(f.fenceDepth() > 0);
      assert.deepEqual(selected, capture);
      const original = { ...source(), operationRef: 'TEST-service-' + ++sequence };
      return operation === 'stop'
        ? { ...original, command: { operation: 'stop', capture: structuredClone(selected) } }
        : { ...original, command: { operation: 'settle', capture: structuredClone(selected) } };
    },
    async run(intent, _deadline) {
      assert.equal(f.fenceDepth(), 0, 'Native dispatch/await never holds the Team fence');
      const receipt = [...f.files.values()].find(value => {
        const row = value as ProcessCommandReceipt;
        return row.nativeIntent?.operationRef === intent.operationRef ||
          row.nativeSettlement?.operationRef === intent.operationRef;
      }) as ProcessCommandReceipt | undefined;
      assert.ok(receipt, 'Original intent is durable before first native dispatch');
      assert.equal(replies.has(intent.operationRef), false, 'No native operation replay');
      if (intent.command.operation === 'settle' && pause === 'admission')
        await holdReply('admission', { state: 'unknown' }); // Real Main lookup is unknown before original admission.
      let value: WindowsServiceOutcome;
      if (intent.command.operation === 'capture') {
        captures++;
        assert.equal(receipt.originalRegistration?.policyRequested, false);
        value = captureReply ?? { state: 'captured', capture: structuredClone(capture) };
      } else if (intent.command.operation === 'stop') {
        stops++; value = { state: 'unknown' };
      } else {
        settlements++; lastSettlement = intent.operationRef;
        assert.ok(receipt.state.native === 'observed-absent' || receipt.nativeAbsence?.settlement === 'requested');
        value = settlementReply ?? { state: 'settled', capture: structuredClone(capture) };
      }
      replies.set(intent.operationRef, structuredClone(value));
      return holdReply('run', loseCapture && intent.command.operation === 'capture' ? { state: 'unknown' } : value);
    },
    async lookup(intent, _deadline) {
      assert.equal(f.fenceDepth(), 0);
      return holdReply('lookup', replies.get(intent.operationRef) ?? { state: 'unknown' });
    },
    async query(selected, _deadline) {
      assert.equal(f.fenceDepth(), 0);
      assert.deepEqual(selected, capture);
      return holdReply('query', { state: 'observed', capture: structuredClone(capture),
        observation: absent ? 'absent' : 'same-live', evidence: 'native-scope' });
    },
  };
  return { ...f, capture, commands: f.windows(port), cold: () => f.windows(port),
    asPrincipal: (principalId: string) => f.windows(port, principalId),
    deadline: () => performance.now() + 10000,
    captures: () => captures, stops: () => stops, settlements: () => settlements,
    loseCapture: () => { loseCapture = true; },
    captureReply: (value: WindowsServiceOutcome) => { captureReply = structuredClone(value); },
    pause: (kind: 'run' | 'lookup' | 'query' | 'admission') => { pause = kind; },
    async atPause() {
      for (let turn = 0; turn < 32 && !pending; turn++) await Promise.resolve();
      assert.ok(pending, 'Bounded synthetic native boundary reached');
    },
    settlementReply: (value?: WindowsServiceOutcome) => { settlementReply = value; },
    settleLate() {
      assert.ok(lastSettlement);
      replies.set(lastSettlement, { state: 'settled', capture: structuredClone(capture) });
    },
    release: (value?: WindowsServiceOutcome) => { assert.ok(pending); pending.finish(value); },
    absent: () => { absent = true; },
  };
}

test('Windows lost capture ACK uses original receipt on cold lookup and async MCP strips private capability', async () => {
  const f = windowsFixture(); f.loseCapture();
  const tools = createProcessMcpTools({
    register: (commandId, input) => f.commands.windows!.register(commandId, input, f.deadline()),
    metadata: f.commands.metadata,
    list: () => f.commands.windows!.list(f.deadline()),
    lookup: commandId => f.cold().windows!.lookup(commandId, f.deadline()),
  });
  assert.ok(tools.every(tool => tool.asynchronous === true));
  const call = (name: string, input: unknown) => tools.find(tool => tool.definition.name === name)!.invoke(input);
  const held = await call('process_register', { commandId: 'TEST-window-register', pid: 1001, label: ' TEST service ' }) as { phase: string };
  assert.equal(held.phase, 'held'); assert.equal(f.rows().length, 0); assert.equal(f.captures(), 1);
  const completed = await call('process_lookup', { commandId: 'TEST-window-register' }) as { phase: string };
  assert.equal(completed.phase, 'completed'); assert.equal(f.policyRegistrations(), 1);
  const replay = await call('process_register', { commandId: 'TEST-window-register', pid: 1001, label: ' TEST service ' });
  assert.deepEqual(replay, completed); assert.equal(f.captures(), 1); assert.equal(f.policyRegistrations(), 1);
  assert.equal(f.commands.list()[0]!.observation, 'unknown', 'Sync Team snapshot cannot fabricate a native query');
  const listed = await call('process_list', {}) as { observation: string; canTerminate: boolean }[];
  assert.equal(listed[0]!.observation, 'same-live'); assert.equal(listed[0]!.canTerminate, true);
  for (const privateField of ['mainEpoch', 'providerCapability', 'nativeIntent', 'operationRef', 'capturedNative'])
    assert.equal(JSON.stringify({ completed, listed }).includes(privateField), false);

  const missing: WindowsServiceOutcome = { state: 'refused', reason: 2, nativeCode: 1168 };
  const input = { pid: 1001, label: 'TEST missing original service' };
  for (const lost of [false, true]) {
    const refused = windowsFixture(); refused.captureReply(missing);
    if (lost) refused.loseCapture();
    const initial = await refused.commands.windows!.register('TEST-missing', input, refused.deadline());
    const originalIntent = stable(initial.nativeIntent), originalInput = stable(initial.originalRegistration);
    assert.equal(initial.phase, lost ? 'held' : 'rejected');
    if (lost) assert.throws(() => refused.coldUnavailable().assertReleased(), /hold/);
    const settled = await refused.cold().windows!.lookup('TEST-missing', refused.deadline());
    assert.ok(settled); assert.equal(settled.phase, 'rejected');
    assert.deepEqual(settled.state, { phase: 'refused', native: 'refused' });
    assert.equal(stable(settled.nativeIntent), originalIntent);
    assert.equal(stable(settled.originalRegistration), originalInput);
    assert.equal(settled.requestDigest, digest(input)); assert.equal(settled.capture, undefined);
    assert.equal(settled.originalRegistration?.policyRequested, false);
    assert.deepEqual(await refused.commands.windows!.register('TEST-missing', input, refused.deadline()), settled);
    assert.deepEqual(await refused.cold().windows!.lookup('TEST-missing', refused.deadline()), settled);
    assert.equal(refused.captures(), 1); assert.equal(refused.policyRegistrations(), 0);
    assert.equal(refused.rows().length, 0); assert.equal(refused.stops(), 0); assert.equal(refused.settlements(), 0);
    refused.coldUnavailable().assertReleased(); // Only this rejected command's journal debt ended.
  }
  const uncertain: WindowsServiceOutcome[] = [
    { state: 'unknown' }, { state: 'refused', reason: 2, nativeCode: 5 },
    { state: 'refused', reason: 4, nativeCode: 1168 }, { state: 'refused', reason: 6, nativeCode: 1168 },
  ];
  for (const reply of uncertain) {
    const held = windowsFixture(); held.captureReply(reply);
    const receipt = await held.commands.windows!.register('TEST-uncertain', input, held.deadline());
    assert.equal(receipt.phase, 'held');
    assert.deepEqual(await held.cold().windows!.lookup('TEST-uncertain', held.deadline()), receipt);
    assert.equal(held.captures(), 1); assert.equal(held.policyRegistrations(), 0);
    assert.equal(held.rows().length, 0); assert.equal(held.stops(), 0); assert.equal(held.settlements(), 0);
    assert.throws(() => held.coldUnavailable().assertReleased(), /hold/);
  }
  const notSent = windowsFixture(); notSent.captureReply({ state: 'not-dispatched', reason: 'admission' });
  const notDispatched = await notSent.commands.windows!.register('TEST-not-sent', input, notSent.deadline());
  assert.deepEqual(notDispatched.state, { phase: 'refused', native: 'not-requested' });
  assert.equal(notSent.policyRegistrations(), 0); notSent.coldUnavailable().assertReleased();

  const retained = windowsFixture();
  const prior = await retained.commands.windows!.register('TEST-prior-capture', input, retained.deadline());
  const priorRows = stable(retained.rows()); retained.captureReply(missing);
  const rejected = await retained.commands.windows!.register('TEST-second-missing', input, retained.deadline());
  assert.equal(rejected.phase, 'rejected');
  assert.deepEqual(await retained.cold().windows!.lookup('TEST-prior-capture', retained.deadline()), prior);
  assert.equal(stable(retained.rows()), priorRows);
  assert.equal(retained.captures(), 2); assert.equal(retained.policyRegistrations(), 1);
  assert.equal(retained.stops(), 0); assert.equal(retained.settlements(), 0);
  assert.throws(() => retained.coldUnavailable().assertReleased(), /hold/);
});

test('Windows original input is checked outside Team fence after capture await and before any policy effect', async () => {
  const f = windowsFixture(); f.pause('run');
  const pending = f.commands.windows!.register('TEST-source-change', { pid: 1001, label: 'TEST service' }, f.deadline());
  assert.equal(f.captures(), 1); f.sourceChanged(); f.release();
  await assert.rejects(pending, /forbidden/);
  assert.equal(f.rows().length, 0); assert.equal(f.policyRegistrations(), 0);
  f.restoreSource();
  assert.equal((await f.cold().windows!.lookup('TEST-source-change', f.deadline()))!.phase, 'completed');
  assert.equal(f.captures(), 1); assert.equal(f.policyRegistrations(), 1);
});

test('Windows expired capture retains evidence without policy; a later saved-capture lookup still checks original source', async () => {
  const f = windowsFixture(); f.pause('run');
  const deadline = performance.now() + 20;
  const pending = f.commands.windows!.register('TEST-expired-policy', { pid: 1001, label: 'TEST service' }, deadline);
  await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.ceil(deadline - performance.now()) + 1)));
  f.release(); // Deliberately late synthetic result exercises the application deadline, independently of native filtering.
  const held = await pending;
  assert.equal(held.phase, 'held'); assert.equal(held.capture?.version, 5);
  assert.equal(held.originalRegistration?.policyRequested, false);
  assert.equal(f.policyRegistrations(), 0);
  f.pause('lookup');
  const later = f.cold().windows!.lookup('TEST-expired-policy', f.deadline());
  f.sourceChanged(); f.release({ state: 'unknown' });
  await assert.rejects(later, /forbidden/);
  assert.equal(f.policyRegistrations(), 0);
  f.restoreSource();
  assert.equal((await f.cold().windows!.lookup('TEST-expired-policy', f.deadline()))!.phase, 'completed');
  assert.equal(f.captures(), 1); assert.equal(f.policyRegistrations(), 1);
});

test('Windows uncertain original policy writes never register twice and only exact attached row can complete', async () => {
  for (const interruption of ['register', 'attach'] as const) {
    const f = windowsFixture(); f.interruptPolicy(interruption);
    await assert.rejects(f.commands.windows!.register('TEST-policy-write', { pid: 1001, label: 'TEST service' }, f.deadline()), /TEST interrupted/);
    f.interruptPolicy();
    const receipt = await f.cold().windows!.lookup('TEST-policy-write', f.deadline());
    assert.equal(receipt!.phase, interruption === 'attach' ? 'completed' : 'held');
    assert.equal(f.policyRegistrations(), 1); assert.equal(f.captures(), 1);
    assert.equal(receipt!.originalRegistration?.policyRequested, true);
    if (interruption === 'register') {
      assert.equal(f.rows()[0]!.capturedNative, undefined);
      assert.equal(f.rows()[0]!.capturedByCommand, undefined, 'Uncertain metadata is never attached by PID');
      f.pause('lookup');
      const contradictory = f.cold().windows!.lookup('TEST-policy-write', f.deadline());
      f.release({ state: 'refused', reason: 2, nativeCode: 1168 });
      assert.deepEqual(await contradictory, receipt, 'Missing cannot erase the saved capture or original policy debt');
      assert.throws(() => f.coldUnavailable().assertReleased(), /hold/);
      assert.equal((await f.cold().windows!.lookup('TEST-policy-write', f.deadline()))!.phase, 'held');
      f.replace([{ ...f.rows()[0]!, capturedNative: { ...f.capture,
        target: { ...f.capture.target, birth: '0000000000000020' } } }]);
      await assert.rejects(f.cold().windows!.lookup('TEST-policy-write', f.deadline()), /conflict/);
      assert.equal(f.policyRegistrations(), 1); assert.equal(f.captures(), 1);
    }
  }
});

test('Windows Stop uncertainty survives metadata removal and replacement; cold absence belongs to full original scope', async () => {
  const f = windowsFixture();
  await f.commands.windows!.register('TEST-native-register', { pid: 1001, label: 'TEST original' }, f.deadline());
  const row = (await f.commands.windows!.list(f.deadline()))[0]!;
  const stopped = await f.commands.windows!.terminate('TEST-native-stop', row.processRef, f.deadline());
  assert.deepEqual(stopped.state, { phase: 'requested', native: 'unknown' }); assert.equal(f.stops(), 1);
  await assert.rejects(f.cold().windows!.terminate('TEST-second-stop', row.processRef, f.deadline()), /hold/);
  f.commands.metadata('TEST-unregister', 'unregister', { processRef: row.processRef });
  const replacement: TeamProcessRow = { id: 'TEST-replacement', pid: row.pid, label: 'TEST untouched',
    registeredAt: '2026-11-13T00:00:00.000Z' };
  f.replace([replacement]);
  assert.equal(f.cold().list().length, 2, 'Original requested receipt remains visible after unregister');
  f.absent();
  const completed = await f.cold().windows!.lookup('TEST-native-stop', f.deadline());
  assert.deepEqual(completed!.state, { phase: 'completed', native: 'observed-absent', signalAccepted: 'unknown' });
  assert.deepEqual(f.rows(), [replacement]); assert.equal(f.stops(), 1); assert.equal(f.settlements(), 1);
  assert.equal((await f.cold().windows!.lookup('TEST-native-stop', f.deadline()))!.state.native, 'observed-absent');
  assert.equal(f.settlements(), 1, 'Settle replay reads the same original pending result');
  assert.equal(f.coldUnavailable().lookup('TEST-native-stop')!.state.native, 'observed-absent');
  assert.equal(f.captures(), 1, 'Neither Stop lookup nor a replacement PID can recapture');
  for (const reason of ['capacity', 'deadline', 'unknown'] as const) {
    const held = windowsFixture();
    const registration = await held.commands.windows!.register('TEST-settle-register', { pid: 1001, label: 'TEST settlement' }, held.deadline());
    const target = (await held.commands.windows!.list(held.deadline()))[0]!;
    await held.commands.windows!.terminate('TEST-settle-stop', target.processRef, held.deadline());
    held.absent(); held.settlementReply(reason === 'unknown' ? { state: 'unknown' } : { state: 'not-dispatched', reason });
    const original = (await held.cold().windows!.lookup('TEST-settle-stop', held.deadline()))!;
    assert.equal(held.settlements(), 1, 'No retry in the call which first observes no-dispatch');
    assert.equal(original.nativeSettlementNotDispatched, reason === 'unknown' ? undefined : true);
    assert.equal(JSON.stringify(projectProcessReceipt(original)).includes('nativeSettlement'), false);
    if (reason === 'unknown') {
      await held.cold().windows!.lookup('TEST-settle-stop', held.deadline());
      assert.equal(held.settlements(), 1, 'Unknown permits only the original intent lookup');
      held.settleLate();
      assert.deepEqual((await held.cold().windows!.lookup('TEST-settle-stop', held.deadline()))!.nativeSettlement, original.nativeSettlement);
      continue;
    }
    const legacy = structuredClone(original); delete legacy.nativeSettlementNotDispatched;
    legacy.fingerprint = processReceiptFingerprint(legacy, digest);
    assert.notEqual(legacy.fingerprint, original.fingerprint); validateProcessReceipt(legacy, digest);
    for (const invalid of [Object.assign(structuredClone(original), { nativeSettlementNotDispatched: false }),
      Object.assign(structuredClone(registration), { nativeSettlementNotDispatched: true })]) {
      const malformed = invalid as unknown as ProcessCommandReceipt;
      malformed.fingerprint = processReceiptFingerprint(malformed, digest);
      assert.throws(() => validateProcessReceipt(malformed, digest), /hold/);
    }
    held.settlementReply(); held.pause('admission');
    const retry = held.cold().windows!.lookup('TEST-settle-stop', held.deadline()); await held.atPause();
    const concurrent = (await held.cold().windows!.lookup('TEST-settle-stop', held.deadline()))!;
    assert.equal(concurrent.nativeSettlementNotDispatched, undefined); assert.equal(held.settlements(), 1);
    assert.notDeepEqual(concurrent.nativeSettlement, original.nativeSettlement);
    held.release(); const settled = (await retry)!;
    assert.deepEqual(settled.nativeSettlement, concurrent.nativeSettlement);
    await held.cold().windows!.lookup('TEST-settle-stop', held.deadline());
    assert.equal(held.settlements(), 2); assert.equal(held.stops(), 1); assert.equal(held.captures(), 1);
    assert.equal(original.nativeSettlementNotDispatched, true, 'Earlier no-dispatch receipt stays immutable');
  }
});

test('Windows natural absence stays on one original register across principals and cold reads, without a Stop', async () => {
  const f = windowsFixture(), member = f.asPrincipal('TEST-original-member');
  const registered = await member.windows!.register('TEST-natural-a', { pid: 1001, label: 'TEST natural' }, f.deadline());
  await member.windows!.register('TEST-natural-b', { pid: 1001, label: 'TEST same scope' }, f.deadline());
  const receipt = (id: string) => f.files.get('commands/' + digest(id) + '.json') as ProcessCommandReceipt;
  await assert.rejects(f.cold().windows!.lookup('TEST-natural-a', f.deadline()), /forbidden/);
  f.absent();
  assert.throws(() => f.cold().assertReleased(), /hold/);
  await f.cold().windows!.reconcileNaturalAbsence(f.deadline()); // No prior list and no synthetic human Stop.
  const durable = receipt('TEST-natural-a');
  assert.equal(durable.operation, 'register'); assert.equal(durable.principalId, 'TEST-original-member');
  assert.deepEqual(durable.state, { phase: 'completed', native: 'not-requested' });
  assert.deepEqual(durable.capture, f.capture);
  assert.deepEqual(durable.nativeAbsence, { schemaVersion: 1, kind: 'windows-service-absence-v1',
    captureDigest: digest(f.capture), evidence: 'native-scope', settlement: 'settled' });
  assert.equal(receipt('TEST-natural-b').nativeAbsence, undefined, 'One anchor for the same physical scope');
  const legacy = structuredClone(durable);
  delete legacy.nativeAbsence; delete legacy.nativeSettlement;
  assert.equal(processReceiptFingerprint(legacy, digest), registered.fingerprint, 'Absent optional fields keep legacy fingerprint bytes');
  f.coldUnavailable().assertReleased();
  assert.equal(f.coldUnavailable().list()[0]!.observation, 'absent');
  assert.equal(f.coldUnavailable().list()[0]!.canTerminate, false);
  f.commands.metadata('TEST-natural-remove', 'unregister', { pid: 1001 });
  f.coldUnavailable().assertReleased();
  await f.cold().windows!.reconcileNaturalAbsence(f.deadline());
  assert.equal(f.settlements(), 1); assert.equal(f.stops(), 0); assert.equal(f.captures(), 2);
  assert.equal([...f.files.values()].some(value => (value as ProcessCommandReceipt).operation === 'terminate'), false);
  assert.throws(() => f.coldUnavailable().lookup('TEST-natural-a'), /forbidden/);
});

test('Windows natural settlement preserves pre-dispatch and lost-ACK uncertainty; only later proven no-dispatch may retry', async () => {
  const f = windowsFixture();
  await f.commands.windows!.register('TEST-natural-concurrent', { pid: 1001, label: 'TEST natural' }, f.deadline());
  f.absent(); f.pause('admission');
  const first = f.commands.windows!.reconcileNaturalAbsence(f.deadline());
  await f.atPause();
  const stored = () => f.files.get('commands/' + digest('TEST-natural-concurrent') + '.json') as ProcessCommandReceipt;
  const intent = structuredClone(stored().nativeSettlement);
  assert.equal(stored().nativeAbsence?.settlement, 'requested');
  await f.cold().windows!.reconcileNaturalAbsence(f.deadline());
  assert.equal(f.settlements(), 0, 'A serialized lookup before original admission is unknown, never no-dispatch');
  assert.deepEqual(stored().nativeSettlement, intent); assert.equal(stored().nativeAbsence?.settlement, 'requested');
  assert.throws(() => f.coldUnavailable().assertReleased(), /hold/);
  f.release(); await first;
  f.coldUnavailable().assertReleased(); assert.equal(f.settlements(), 1);

  const lost = windowsFixture();
  await lost.commands.windows!.register('TEST-natural-lost', { pid: 1001, label: 'TEST lost ACK' }, lost.deadline());
  lost.absent(); lost.settlementReply({ state: 'unknown' });
  await lost.commands.windows!.reconcileNaturalAbsence(lost.deadline());
  const original = [...lost.files.values()][0] as ProcessCommandReceipt;
  await lost.cold().windows!.reconcileNaturalAbsence(lost.deadline());
  assert.throws(() => lost.coldUnavailable().assertReleased(), /hold/);
  assert.equal(lost.settlements(), 1);
  lost.settleLate();
  await lost.cold().windows!.reconcileNaturalAbsence(lost.deadline());
  const completed = [...lost.files.values()][0] as ProcessCommandReceipt;
  assert.deepEqual(completed.nativeSettlement, original.nativeSettlement);
  assert.equal(original.nativeAbsence?.settlement, 'requested', 'Previously returned unknown evidence is immutable');
  lost.coldUnavailable().assertReleased(); assert.equal(lost.settlements(), 1);

  const refused = windowsFixture();
  await refused.commands.windows!.register('TEST-natural-no-dispatch', { pid: 1001, label: 'TEST pressure' }, refused.deadline());
  refused.absent(); refused.settlementReply({ state: 'not-dispatched', reason: 'capacity' });
  await refused.commands.windows!.reconcileNaturalAbsence(refused.deadline());
  const notDispatched = [...refused.files.values()][0] as ProcessCommandReceipt;
  assert.equal(notDispatched.nativeAbsence?.settlement, 'not-dispatched');
  assert.equal(refused.settlements(), 1, 'No automatic retry in the original call');
  assert.throws(() => refused.coldUnavailable().assertReleased(), /hold/);
  refused.settlementReply();
  await refused.cold().windows!.reconcileNaturalAbsence(refused.deadline());
  const retry = [...refused.files.values()][0] as ProcessCommandReceipt;
  assert.notEqual(retry.nativeSettlement?.operationRef, notDispatched.nativeSettlement?.operationRef);
  assert.equal(refused.settlements(), 2); assert.equal(refused.captures(), 1); assert.equal(refused.stops(), 0);
  refused.coldUnavailable().assertReleased();
});

test('Windows natural evidence cannot cross a changed source, grant, deadline, capture or concurrent original Stop', async () => {
  for (const change of ['source', 'grant', 'deadline', 'capture'] as const) {
    const f = windowsFixture();
    const registered = await f.commands.windows!.register('TEST-natural-guard', { pid: 1001, label: 'TEST guard' }, f.deadline());
    f.absent(); f.pause('query');
    const deadline = change === 'deadline' ? performance.now() + 20 : f.deadline();
    const pending = f.commands.windows!.reconcileNaturalAbsence(deadline);
    await f.atPause();
    if (change === 'source') f.sourceChanged();
    if (change === 'grant') f.revoke();
    if (change === 'deadline')
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.ceil(deadline - performance.now()) + 1)));
    f.release(change === 'capture' ? { state: 'observed', capture: {
      ...f.capture, root: { ...f.capture.root, birth: '0000000000000020' },
    }, observation: 'absent', evidence: 'native-scope' } : undefined);
    if (change === 'source' || change === 'grant') await assert.rejects(pending, /forbidden/);
    else await pending;
    const stored = [...f.files.values()][0] as ProcessCommandReceipt;
    assert.equal(stored.nativeAbsence, undefined); assert.equal(stored.fingerprint, registered.fingerprint);
    assert.equal(f.settlements(), 0); assert.equal(f.stops(), 0);
  }
  const f = windowsFixture();
  await f.commands.windows!.register('TEST-natural-stop-race', { pid: 1001, label: 'TEST race' }, f.deadline());
  const reference = (await f.commands.windows!.list(f.deadline()))[0]!.processRef;
  f.absent(); f.pause('query');
  const natural = f.commands.windows!.reconcileNaturalAbsence(f.deadline());
  await f.atPause();
  await f.commands.windows!.terminate('TEST-original-stop-race', reference, f.deadline());
  f.release();
  await assert.rejects(natural, /hold/);
  assert.equal(f.settlements(), 0, 'Unresolved original Stop holds natural settlement after query');
  await f.cold().windows!.lookup('TEST-original-stop-race', f.deadline());
  await f.cold().windows!.reconcileNaturalAbsence(f.deadline());
  const registration = f.files.get('commands/' + digest('TEST-natural-stop-race') + '.json') as ProcessCommandReceipt;
  assert.equal(registration.nativeAbsence, undefined, 'Completed genuine Stop keeps its own settlement path');
  assert.equal(f.stops(), 1); assert.equal(f.settlements(), 1); assert.equal(f.captures(), 1);
  f.coldUnavailable().assertReleased();
});
