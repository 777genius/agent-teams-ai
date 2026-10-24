import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createTeamProcessCommands } from '../dist/process/TeamProcessCommands.js';
import { createTeamProcessMethods } from '../dist/process/createTeamProcessMethods.js';
import type {
  ProcessCommandReceipt,
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
function fixture(ancestry = false) {
  const files = new Map<string, unknown>();
  let rows: TeamProcessRow[] = [],
    signals = 0,
    lostAck = false,
    current = true,
    absent = false,
    unknown = false,
    captures = 0,
    corrupt = false;
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
  if (ancestry) capture = {
    ...capture, version: 2, admission: 'live-ancestry-v1', target: { ...capture.target, sessionId: 2000 },
  };
  const options = {
    binding: { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'TEST-team' },
    principalId: 'TEST-human',
    digest,
    store: {
      fenced<T>(action: () => T) {
        return action();
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
      register(input: { pid: number; label: string; from: string }) {
        const row = {
          id: 'TEST-process',
          pid: input.pid,
          label: input.label,
          registeredBy: input.from,
          registeredAt: '2026-10-23T00:00:00.000Z',
        };
        rows.push(row);
        return structuredClone(row);
      },
      attachOriginal(id: string, commandId: string, capture: RegisteredProcessCapture) {
        rows = rows.map((row) =>
          row.id === id ? { ...row, capturedNative: capture, capturedByCommand: commandId } : row
        );
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
  assert.equal(receipt.capture?.version, 2);
  assert.equal(receipt.capture?.target.sessionId, 2000);
  const cold = f.cold(), row = cold.list()[0]!;
  assert.equal(row.canTerminate, true);
  assert.ok(!JSON.stringify(row).includes('auditToken'));
  f.unknown(); // Native same-token SID drift is UNKNOWN, never stale/absence.
  assert.equal(cold.list()[0]!.observation, 'unknown');
  assert.equal(cold.list()[0]!.canTerminate, false);
  assert.throws(() => cold.terminate('TEST-no-SID-drift-stop', row.processRef), /hold/);
  assert.throws(() => cold.assertReleased(), /hold/);
  assert.equal(cold.lookup('TEST-live-ancestry-register')?.capture?.target.sessionId, 2000);
  assert.equal(f.captures(), 1, 'Cold lookup cannot expand admission using a fresh lineage walk');
  assert.equal(f.signals(), 0);
  f.absent(); cold.assertReleased();
});
