import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scenario = read('tools/owned-process-broker/nativeEmulatedSourceScenario.ts');
const profile = read('tools/owned-process-broker/nativeEmulatedSourceProfile.ts');
const readiness = read('tools/owned-process-broker/nativeEmulatedSourceReadiness.ts');
const clientSource = read('src/features/agent-backend/main/infrastructure/CapturedHostClient.ts');
const mainReadiness = read('src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness.ts');
const selectedProfile = read('src/features/agent-backend/main/infrastructure/selectedHostProfile.ts');
const custody = read('packages/legacy-agent-host/src/owned-process/hostCustody.ts');
const between = (source: string, start: string, end: string) => {
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  return source.slice(source.indexOf(start), source.indexOf(end));
};
const javascript = (source: string) => stripTypeScriptTypes(source.replace(/^export /gm, ''), { mode: 'transform' });
const policyStart = 'export const emulatedSourceOpenCodeRequestTimeoutMs';
const policy = readiness.includes(policyStart)
  ? javascript(between(readiness, policyStart, 'export function readEmulatedSourceActionProbe(')) : '';
const hostInitializer = javascript(between(profile, '  const host: SelectedHostProfile =', '  const owner ='));
const hostError = javascript(between(selectedProfile, 'export class HostClientError', '/** Trusted composition input.'));
const originalRequest = javascript('class OriginalClient {' + between(clientSource, '  request(\n', '  private send(') + '}');
const custodyMethod = javascript(between(custody, 'export const HOST_CUSTODY_METHOD =', '\nexport const HOST_CUSTODY_SHUTDOWN_METHOD'));
const mainBudget = javascript(between(mainReadiness, 'export function captureRequestReadinessBudget(', '\nfunction currentReadiness('));
const pollSource = javascript(between(scenario, 'async function poll(', 'function validateSourceRefusal('));
const rpcSource = javascript(between(scenario, '    const rpc = async (', '    const management = ('));
const observerSource = javascript(between(scenario,
  '      // Original readiness observation starts once after the Start acknowledgement.',
  '      const jobs = epoch.jobs.slice(before);'));

type Provider = 'codex' | 'claude' | 'opencode';
type Row = Record<string, unknown>;
type RequestOptions = { control?: boolean; remainingMs?: () => number };
type Sent = { timeoutMs: number; control: boolean; method: string; params: Row; sampledAt: number };

function fixture(input: {
  provider?: Provider; callerCeiling?: number; initialMs?: number; ackMs?: number; handoffMs?: number;
  samplePauseMs?: number; readCosts?: number[]; ready?: boolean[]; readError?: Error;
} = {}) {
  const provider = input.provider ?? 'opencode';
  let now = input.initialMs ?? 0, clockReads = 0;
  const performance = { now: () => { clockReads++; return now; } };
  const owner = { profileId: 'TEST-profile', buildId: 'TEST-build' };
  const common = { assert, performance };
  const host = runInNewContext(`(()=>{${policy}\n${hostInitializer}\nreturn host;})()`, {
    ...common, provider, profile: { owner }, node: '/TEST-node', root: '/TEST-root', systemRoot: '/TEST-system',
    hostEntry: '/TEST-host', profilePath: '/TEST-profile', process: { version: 'v24.21.0' },
    fileHash: () => 'a'.repeat(64), realpathSync: { native: (path: string) => path }, dirname, join,
  }) as { requestTimeoutMs: number; startupTimeoutMs: number; writeTimeoutMs: number; shutdownTimeoutMs: number };
  if (input.callerCeiling !== undefined) host.requestTimeoutMs = input.callerCeiling;
  const evidence: { lastLaunchReadiness?: Row } = {};
  const sent: Sent[] = [], optionsSeen: RequestOptions[] = [], delays: number[] = [], pollDeadlines: unknown[] = [];
  const request = runInNewContext(`(()=>{${hostError}\n${custodyMethod}\n${originalRequest}\nreturn OriginalClient.prototype.request;})()`, common) as
    (this: object, method: string, params: Row, options: RequestOptions) => Promise<Row>;
  const client = {
    profile: host, ready: true, sealed: false, quiescing: false,
    request(method: string, params: Row, options: RequestOptions) {
      optionsSeen.push(options); now += input.samplePauseMs ?? 0;
      return request.call(client, method, params, options);
    },
    async send(method: string, params: Row, control: boolean, timeoutMs: number) {
      const index = sent.length;
      sent.push({ method, params, control, timeoutMs, sampledAt: now });
      now += input.readCosts?.[index] ?? 0;
      if (input.readError) throw input.readError;
      return { memberId: 'alice-id', generation: 'TEST-original', phase: 'allocated', sealed: false,
        custody: 'owned', nativeReady: input.ready?.[index] ?? true, attached: true };
    },
  };
  const context = {
    ...common, provider, client, evidence, team: 0, action: 'A', image: 'A', launchId: 'TEST-launch',
    source: { sourceId: 'TEST-source', revision: 'TEST-revision' }, sourceRef: (value: Row) => value,
    fixture: { host, profile: { owner, teams: [{ scope: { teamId: 'TEST-team' } }] } },
    descriptor: { handles: [{ handleId: 'TEST-handle' }] }, json: (value: unknown) => value,
    unwrap: (value: unknown) => value, runtimeDigest: (value: unknown) => JSON.stringify(value),
    console: { log() {} }, delay: async (ms: number) => { delays.push(ms); now += ms; },
    afterAck: async () => { now += input.ackMs ?? 0; },
    handoff: (deadline: unknown) => { pollDeadlines.push(deadline); now += input.handoffMs ?? 0; },
    held: () => { throw new Error('TEST original preparation held'); },
  };
  const controlled = runInNewContext(`(()=>{
    ${policy}\n${mainBudget}\n${pollSource}\n${rpcSource}
    const originalPoll=poll; poll=(check,message,budget,deadline)=>{handoff(deadline);return originalPoll(check,message,budget,deadline);};
    const epoch={rpc};
    return { rpc, captureBudget:()=>captureRequestReadinessBudget(fixture.host.requestTimeoutMs), run:async()=>{
      let memberReadinessDeadline,lastRuntimeViewDigest;
      await afterAck();
      { ${observerSource} }
    }};
  })()`, context) as {
    run(): Promise<void>; captureBudget(): { remainingMs(): number };
    rpc(team: number, method: string, command: string, payload: unknown, deadline?: number): Promise<Row>;
  };
  return { ...controlled, host, evidence, sent, optionsSeen, delays, pollDeadlines,
    clock: () => ({ now, clockReads }), advance: (ms: number) => { now += ms; } };
}

test('source OpenCode selects the existing desktop V1 functional caller ceiling only', () => {
  const desktop = read('scripts/legacy-agent-host/desktop-backend-fixture.ts');
  const match = desktop.match(/requestTimeoutMs: (options\.nativeOpenCodeV2 \? [\d_]+ : [\d_]+),/);
  assert.ok(match);
  const desktopV1 = runInNewContext(match[1]!, { options: { nativeOpenCodeV2: false } }) as number;
  assert.equal(desktopV1, 60000);
  for (const provider of ['opencode', 'codex', 'claude'] as const) {
    const f = fixture({ provider });
    assert.equal(f.host.requestTimeoutMs, provider === 'opencode' ? desktopV1 : 15000);
    assert.deepEqual([f.host.startupTimeoutMs, f.host.writeTimeoutMs, f.host.shutdownTimeoutMs], [10000, 5000, 1000]);
  }
});

test('source OpenCode readiness after 15s remains bounded by one post-ACK functional observation', async () => {
  const f = fixture({ initialMs: 1000, ackMs: 20000, readCosts: [16000] });
  const preparation = f.captureBudget();
  await f.run();
  assert.equal(preparation.remainingMs(), 24000, 'the earlier Main preparation is not reanchored by the ACK');
  assert.deepEqual(f.pollDeadlines, [81000]); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.timeoutMs, 60000);
  const observation = f.evidence.lastLaunchReadiness!.observation as Row;
  assert.deepEqual(JSON.parse(JSON.stringify(observation)), { policy: 'desktop-v1-functional-ceiling-v1',
    anchor: 'post-start-ack', ceilingMs: 60000, startedAtMs: 21000, deadlineMs: 81000 });
  assert.equal(Object.isFrozen(observation), true); assert.ok(JSON.stringify(observation).length < 256);
});

test('source OpenCode preserves a caller ceiling below 60s and samples transport remaining after handoff', async () => {
  const f = fixture({ initialMs: 100, ackMs: 50, callerCeiling: 200, handoffMs: 20,
    samplePauseMs: 10, readCosts: [40, 20], ready: [false, true] });
  await f.run();
  assert.deepEqual(f.pollDeadlines, [350]); assert.deepEqual(f.delays, [25]);
  assert.deepEqual(f.sent.map(row => row.timeoutMs), [170, 95]);
  assert.equal(f.clock().now, 275);
  assert.equal(f.optionsSeen.length, 2);
  assert.ok(f.optionsSeen.every(row => typeof row.remainingMs === 'function'));
  assert.equal(f.optionsSeen[0]!.remainingMs!(), 75, 'the original callback follows the clock, not a stale sampled number');
  f.advance(25); assert.equal(f.optionsSeen[0]!.remainingMs!(), 50);
  assert.equal((f.evidence.lastLaunchReadiness!.observation as Row).deadlineMs, 350);
});

test('source OpenCode never starts a read after its original deadline expires during handoff', async () => {
  const f = fixture({ callerCeiling: 200, ackMs: 50, handoffMs: 200 });
  await assert.rejects(f.run(), /Original source Team readiness/);
  assert.deepEqual(f.pollDeadlines, [250]); assert.equal(f.sent.length, 0); assert.equal(f.optionsSeen.length, 0);
  assert.deepEqual(f.delays, []);
});

for (const readCost of [200, 201])
test(`source OpenCode refuses ready results at or after the unchanged cutoff (${readCost}ms)`, async () => {
  const f = fixture({ callerCeiling: 200, readCosts: [readCost] });
  await assert.rejects(f.run(), /Original source Team readiness/);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.delays, []);
  assert.equal((f.evidence.lastLaunchReadiness!.lastRuntimeRead as Row).nativeReady, true);
  assert.deepEqual(f.pollDeadlines, [200]);
});

test('source OpenCode refuses expiry before the existing client samples the callback without native dispatch', async () => {
  const f = fixture({ callerCeiling: 200, samplePauseMs: 200 });
  await assert.rejects(f.run(), { code: 'request-timeout', outcome: 'not-dispatched' });
  assert.equal(f.sent.length, 0); assert.equal(f.optionsSeen.length, 1); assert.deepEqual(f.delays, []);
});

test('source OpenCode repeated false reads consume one deadline without a renewal or additional Start', async () => {
  const f = fixture({ callerCeiling: 100, readCosts: [20, 20, 20], ready: [false, false, false] });
  await assert.rejects(f.run(), /Original source Team readiness/);
  assert.deepEqual(f.pollDeadlines, [100]); assert.deepEqual(f.delays, [25, 25]);
  assert.deepEqual(f.sent.map(row => row.timeoutMs), [100, 55, 10]);
  assert.equal(f.clock().now, 110);
  assert.ok(f.sent.every(row => row.method === 'runtime.read'));
});

test('source observation preserves the exact read error without retry', async () => {
  const failure = new Error('TEST original read failure'), f = fixture({ readError: failure });
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.delays, []);
});

test('source Codex, Claude and unrelated OpenCode RPCs keep their original observation and request behavior', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const f = fixture({ provider, ackMs: 20000, readCosts: [14999] }); await f.run();
    assert.deepEqual(f.pollDeadlines, [provider === 'codex' ? 35000 : undefined]);
    assert.equal(f.optionsSeen[0]!.remainingMs, undefined); assert.equal(f.sent[0]!.timeoutMs, 15000);
    assert.equal(f.evidence.lastLaunchReadiness!.observation, undefined);
  }
  const f = fixture();
  await f.rpc(0, 'runtime.stop', 'TEST-stop', { memberId: 'alice-id' });
  assert.equal(f.sent[0]!.timeoutMs, 60000); assert.equal(f.optionsSeen[0]!.remainingMs, undefined);
  assert.equal(f.sent[0]!.control, true);
  assert.ok(scenario.includes("}, 'Original B model probe', 30000)"));
  assert.ok(scenario.includes("}, 'Original source input terminal')"));
  assert.ok(scenario.includes("else evidence.standalone = { supported: false, reason: 'Original scheduledRunProfile rejects OpenCode' }"));
});
