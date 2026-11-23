import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('./opencode-v2-embedded-host.native.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (start: string, end: string) => {
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  return source.slice(source.indexOf(start), source.indexOf(end));
};
const helperStart = 'function captureNativeInputObservation(';
// The original source without the helper is also executable for the RED check.
const helper = source.includes(helperStart) ? between(helperStart, 'export interface PackagedNativeHostInputs') : '';
const loop = between('    for (const command of commands) {', '    assert.equal(replies.size,');
const receipt = between('        inputObservation:', '        launchObservation:');
const javascript = (text: string) => stripTypeScriptTypes(text, { mode: 'transform' });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown> : {};
type Read = { cost: number; terminal?: 'succeeded' | 'failed' | 'cancelled'; permissions?: string[] };

/** Execute the actual scenario loop/helper/receipt field with only its I/O and clock replaced. */
function fixture(input: {
  ceilingMs?: number; ackMs?: number; reads: Read[]; grantCosts?: number[]; readFailure?: Error;
  grantFailure?: Error; beforeReadMs?: number; inputs?: number;
}) {
  let now = 0, reads = 0, grants = 0, activeInputId = '';
  const calls: { method: string; atMs: number; commandId?: string }[] = [];
  const originals = new Map<string, Record<string, unknown>>();
  const windows: Record<string, unknown>[] = [], delays: number[] = [];
  const commands = Array.from({ length: input.inputs ?? 1 }, (_, index) => ({ commandId: `TEST-original-${index}` }));
  const context = {
    assert, record, performance: { now: () => now }, Date: { now: () => now }, startedAt: 0,
    profile: { runtime: { members: [{ limits: { timeoutMs: input.ceilingMs ?? 120_000 } }] } },
    commands, originals: [], inputIds: [], replies: new Set<string>(),
    inputObservationWindows: windows, inputReadCount: 0, lastInputProgress: undefined,
    model: { failures: [], observations: [] }, modelProgress: [],
    elapsedMs: () => { now += input.beforeReadMs ?? 0; return now; },
    nativeInputProgress: (value: unknown) => value,
    envelope: (commandId: string, payload: unknown) => ({ commandId, payload }),
    tick: async () => { delays.push(25); now += 25; },
    host: { async rpc(method: string, params: Record<string, unknown>) {
      calls.push({ method, atMs: now, ...(typeof params.commandId === 'string' ? { commandId: params.commandId } : {}) });
      if (method === 'team.execute') {
        const id = String(params.commandId);
        if (!originals.has(id)) {
          now += input.ackMs ?? 0;
          activeInputId = `TEST-delivery-${id}`;
          originals.set(id, { ok: true, value: { phase: 'completed', effects: { deliveryId: activeInputId } } });
        }
        return originals.get(id)!;
      }
      if (method === 'runtime.read') {
        if (input.readFailure) throw input.readFailure;
        const row = input.reads[reads++]; assert.ok(row, 'unexpected additional original read');
        now += row.cost;
        return { ok: true, value: { inputs: [{ inputId: activeInputId,
          phase: row.terminal ? 'terminal' : 'consumed', ...(row.terminal ? { terminal: row.terminal } : {}) }],
          interactions: (row.permissions ?? []).map(interactionRef => ({ kind: 'permission', phase: 'pending',
            inputId: activeInputId, interactionRef })) } };
      }
      assert.equal(method, 'runtime.interaction');
      now += input.grantCosts?.[grants++] ?? 0;
      if (input.grantFailure) throw input.grantFailure;
      return { ok: true };
    } },
  };
  const controlled = new Function(...Object.keys(context), `${javascript(helper)}\nreturn {
    run: async()=>{${javascript(loop)}}, observed:()=>({${receipt}}).inputObservation
  };`)(...Object.values(context)) as { run(): Promise<void>; observed(): Record<string, unknown> };
  return { ...controlled, calls, windows, delays, originals, now: () => now };
}

test('native V2 observes a valid original input after 90s within the captured 120s functional window', async () => {
  const f = fixture({ ackMs: 1500, reads: [{ cost: 95_000 }, { cost: 1000, terminal: 'succeeded' }] });
  await f.run();
  assert.deepEqual(f.calls.map(call => call.method), ['team.execute', 'runtime.read', 'runtime.read', 'team.execute']);
  assert.equal(f.originals.size, 1); assert.deepEqual(f.delays, [25]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.windows)), [{ policy: 'captured-runtime-functional-ceiling-v1',
    anchor: 'post-team-execute-ack', ceilingMs: 120_000, startedAtMs: 1500, deadlineMs: 121500 }]);
  assert.equal(Object.isFrozen(f.windows[0]), true);
  assert.deepEqual(f.observed().windows, f.windows);
});

for (const cost of [120_000, 120_001])
test(`native V2 refuses an original successful terminal at or after its cutoff (${cost}ms)`, async () => {
  const f = fixture({ reads: [{ cost, terminal: 'succeeded' }] });
  await assert.rejects(f.run(), /Original native input observation/);
  assert.deepEqual(f.calls.map(call => call.method), ['team.execute', 'runtime.read']);
  assert.equal(f.observed().reads, 1); assert.equal(f.windows.length, 1);
  assert.equal(record((record(f.observed().last).inputs as unknown[])[0]).terminal, 'succeeded',
    'a late actual read is retained as an observation, never accepted as completion');
});

test('native V2 keeps a smaller captured caller ceiling and a single post-ACK anchor', async () => {
  const f = fixture({ ceilingMs: 200, ackMs: 1000, reads: [{ cost: 150 }, { cost: 24, terminal: 'succeeded' }] });
  await f.run(); assert.equal(f.now(), 1199);
  assert.deepEqual(JSON.parse(JSON.stringify(f.windows)), [{ policy: 'captured-runtime-functional-ceiling-v1',
    anchor: 'post-team-execute-ack', ceilingMs: 200, startedAtMs: 1000, deadlineMs: 1200 }]);
});

test('native V2 pending reads cannot renew the original smaller deadline', async () => {
  const f = fixture({ ceilingMs: 100, reads: [{ cost: 20 }, { cost: 20 }, { cost: 20 }, { cost: 1, terminal: 'succeeded' }] });
  await assert.rejects(f.run(), /Original native input observation/);
  assert.equal(f.calls.filter(call => call.method === 'runtime.read').length, 3);
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0]!.deadlineMs, 100);
});

test('native V2 checks the original cutoff immediately before a read after synchronous observer work', async () => {
  const f = fixture({ ceilingMs: 100, beforeReadMs: 100, reads: [{ cost: 0, terminal: 'succeeded' }] });
  await assert.rejects(f.run(), /Original native input observation/);
  assert.deepEqual(f.calls.map(call => call.method), ['team.execute']);
});

test('native V2 refuses a late pending read without sending a native grant', async () => {
  const f = fixture({ ceilingMs: 100, reads: [{ cost: 100, permissions: ['TEST-permission'] }] });
  await assert.rejects(f.run(), /Original native input observation/);
  assert.equal(f.calls.filter(call => call.method === 'runtime.interaction').length, 0);
});

test('native V2 never retries a grant crossing the cutoff or sends the next pending grant', async () => {
  const f = fixture({ ceilingMs: 100, reads: [{ cost: 50, permissions: ['TEST-first', 'TEST-second'], terminal: 'succeeded' }],
    grantCosts: [50] });
  await assert.rejects(f.run(), /Original native input observation/);
  assert.deepEqual(f.calls.map(call => call.method), ['team.execute', 'runtime.read', 'runtime.interaction']);
  assert.deepEqual(f.delays, []); assert.equal(f.observed().reads, 1);
});

test('native V2 retains the original read and grant failure without retry', async () => {
  for (const kind of ['read', 'grant'] as const) {
    const error = new Error(`TEST original ${kind} failure`);
    const f = fixture({ reads: [{ cost: 1, permissions: ['TEST-permission'] }],
      ...(kind === 'read' ? { readFailure: error } : { grantFailure: error }) });
    await assert.rejects(f.run(), value => value === error);
    assert.equal(f.calls.filter(call => call.method === 'runtime.read').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'runtime.interaction').length, kind === 'grant' ? 1 : 0);
    assert.deepEqual(f.delays, []); assert.equal(f.windows.length, 1);
  }
});

test('native V2 still requires succeeded terminal and one grant for each native permission', async () => {
  const failed = fixture({ reads: [{ cost: 1, terminal: 'failed' }] });
  await assert.rejects(failed.run(), { code: 'ERR_ASSERTION' });
  const repeated = fixture({ reads: [{ cost: 1, permissions: ['TEST-permission'] },
    { cost: 1, permissions: ['TEST-permission'], terminal: 'succeeded' }] });
  await assert.rejects(repeated.run(), /one native grant, never retry an uncertain POST/);
  assert.equal(repeated.calls.filter(call => call.method === 'runtime.interaction').length, 1);
});

test('native V2 records exactly two original input windows and keeps existing idempotency reads', async () => {
  const f = fixture({ inputs: 2, reads: [{ cost: 10, terminal: 'succeeded' }, { cost: 20, terminal: 'succeeded' }] });
  await f.run(); assert.equal(f.originals.size, 2); assert.equal(f.windows.length, 2);
  assert.deepEqual(f.calls.filter(call => call.method === 'team.execute').map(call => call.commandId),
    ['TEST-original-0', 'TEST-original-0', 'TEST-original-1', 'TEST-original-1']);
  assert.equal(f.windows[1]!.startedAtMs, 10);
  const bytes = JSON.stringify(f.windows);
  assert.ok(Buffer.byteLength(bytes) < 512); assert.equal(bytes.includes('TEST-'), false);
});
