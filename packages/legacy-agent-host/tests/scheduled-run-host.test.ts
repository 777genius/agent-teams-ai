import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ScheduledRunInput, ScheduledRunSnapshot } from '../dist/composition/scheduledRunContracts.js';
import type { ScheduledRunProviderContext } from '../dist/adapters/providers/ScheduledRunProvider.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, 'original operation must settle'); await tick(); }
}

class ControlledSession implements Session {
  readonly inputs: Input[] = [];
  private events: Event[] = [];
  private wake?: () => void;
  private ended = false;
  closes = 0;
  readonly sessionRef: string;
  private readonly progress: () => void;
  private readonly unknown: boolean;
  constructor(sessionRef: string, progress: () => void, unknown: boolean) {
    this.sessionRef = sessionRef; this.progress = progress; this.unknown = unknown;
  }
  submit: Session['submit'] = async input => {
    this.inputs.push(input);
    return { ok: true, value: { inputId: input.inputId, operationRef: input.operationRef,
      delivery: 'client-consumed', providerAcceptance: 'unknown' } };
  };
  observe = async function* (this: ControlledSession): AsyncIterable<Event> {
    while (!this.ended || this.events.length) {
      const event = this.events.shift();
      if (event) { yield event; this.progress(); }
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  };
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  respondToInteraction: Session['respondToInteraction'] = async () => ({ ok: false, code: 'unsupported' });
  interrupt: Session['interrupt'] = async () => ({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
  checkpoint: Session['checkpoint'] = () => assert.fail('a finite run must never request a checkpoint');
  close: Session['close'] = async () => {
    this.closes++; this.ended = true; this.wake?.();
    return { logicallyClosed: true, cleanup: this.unknown ? 'unknown' : 'confirmed' };
  };
  finish() {
    const input = this.inputs[0]; assert.ok(input);
    const identity = { sessionRef: this.sessionRef, inputId: input.inputId, operationRef: input.operationRef };
    this.events.push(
      { ...identity, kind: 'tool', messageRef: 'TEST-tool-message', toolRef: 'TEST-scheduled-tool',
        name: 'Bash', input: { command: 'TEST command' } },
      { ...identity, kind: 'tool-result', toolRef: 'TEST-scheduled-tool', content: 'TEST tool result', isError: false },
      { ...identity, kind: 'text', messageRef: 'TEST-message', block: 0,
        phase: 'complete', text: 'TEST finite model result' },
      { ...identity, kind: 'usage', inputTokens: 7, outputTokens: 3, cumulativeCostUsd: 0.01 },
      { ...identity, kind: 'result', outcome: 'succeeded' });
    this.wake?.(); delete this.wake;
  }
}

async function fixture(t: TestContext, options: { blockOpen?: boolean; unknown?: boolean; physicalUnknown?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-scheduled-host-')));
  const teamBinding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-scheduled' };
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'human',
    owner: { ownerId: teamBinding.backendId, revision: '1', storageRoot: root, profileId: 'TEST-profile',
      protocolVersion: 1, buildId: 'TEST-scheduled-host', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    teams: [{ binding: teamBinding,
      scope: { projectId: 'TEST-project', workspaceId: 'TEST-project', teamId: teamBinding.teamId,
        runId: 'TEST-team-run', memberId: 'human', generation: '1' },
      savedSettings: { cwd: root, providerId: 'anthropic', prompt: 'TEST saved team prompt' },
      members: [{ memberId: 'lead', name: 'team-lead', role: 'lead',
        delivery: { ...teamBinding, runId: 'TEST-team-run', memberId: 'lead', generation: '1' } }],
      grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'task.write', 'message.write'] },
        { principalId: 'lead-principal', memberName: 'team-lead', permissions: ['read', 'task.write', 'message.write'] }] }],
    runtime: { members: [{ provider: 'claude', teamId: teamBinding.teamId, memberId: 'lead', principalId: 'lead-principal',
      sessionId: 'PRIVATE-team-session', generation: 1, configRevision: 'PRIVATE-recipe', cwd: root,
      model: 'PRIVATE-default-model', accountBinding: 'PRIVATE-account',
      executable: { path: '/TEST/no-native-execution', sha256: 'c'.repeat(64) },
      environment: { HOME: root, CLAUDE_CONFIG_DIR: root, PATH: '/TEST/no-native-execution', TEST_TOKEN: 'PRIVATE-token' },
      nativeTools: ['Bash', 'Read'], autoAllowedTools: [],
      limits: { queuedInputs: 1, inputBytes: 65536, outputBytes: 65536, outputEvents: 256, pendingInteractions: 1, timeoutMs: 10000 } }] } };
  const binding = { schemaVersion: 1, handleId: 'TEST-handle', owner: profile.owner, scope: profile.teams[0]!.scope };
  const contexts: ScheduledRunProviderContext[] = [], sessions: ControlledSession[] = [], order: string[] = [];
  let input: PassThrough, output: PassThrough, sequence = 0, opens = 0;
  const frames = new Map<number, { result?: unknown; error?: unknown }>();
  let release: (() => void) | undefined;
  let cleanupUnknown = options.unknown === true || options.physicalUnknown === true;
  const composition: NonNullable<Parameters<typeof createTeamHost>[2]> = {
    createProvider: () => assert.fail('standalone execution cannot allocate a Team member'),
    createScheduledProvider(context) {
      contexts.push(context);
      const session = new ControlledSession(context.request.sessionId, context.onProgress, options.unknown === true);
      sessions.push(session);
      return { factory: { async open() {
        opens++; order.push('open-entered');
        if (options.blockOpen) await new Promise<void>(resolve => { release = resolve; });
        order.push('open-returned');
        return { driver: session, capabilities: [...context.request.requiredCapabilities] };
      } }, seal() { order.push('provider-sealed'); }, async cleanup() {
        order.push('original-physical-cleanup'); release?.(); release = undefined;
        return !cleanupUnknown;
      } };
    },
  };
  function open() {
    input = new PassThrough(); output = new PassThrough(); frames.clear();
    let tail = '';
    output.on('data', (chunk: Buffer) => {
      tail += chunk.toString();
      let newline: number;
      while ((newline = tail.indexOf('\n')) >= 0) {
        const frame = JSON.parse(tail.slice(0, newline)); tail = tail.slice(newline + 1);
        frames.set(frame.id, frame);
      }
    });
    return createTeamHost(profile, { input, output }, composition);
  }
  let host = open();
  const raw = async (method: string, params: unknown) => {
    const id = ++sequence; input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    await until(() => frames.has(id));
    const frame = frames.get(id)!; assert.equal(frame.error, undefined);
    return frame.result as { ok: boolean; value: ScheduledRunSnapshot | null; code?: string };
  };
  await raw('host.handshake', { protocolVersion: 1 });
  t.after(async () => { release?.(); await host.dispose(); rmSync(root, { recursive: true, force: true }); });
  const rpc = (method: string, payload: unknown, commandId = 'TEST-read', target = binding) =>
    raw(method, { commandId, binding: target, payload });
  const roster = await rpc('team.roster.read', {}) as unknown as { value: { revision: string } };
  const request = (runId: string, scheduleId = 'TEST-schedule'): ScheduledRunInput => ({ runId, scheduleId, expectedRosterRevision: roster.value.revision,
    config: { cwd: root, prompt: 'TEST standalone prompt', providerId: 'anthropic', model: 'TEST-selected-model',
      effort: 'low', resolvedFastMode: false, skipPermissions: false, allowedTools: ['Read'], disallowedTools: ['Bash'] },
    maxTurns: 2, maxBudgetUsd: 0.5 });
  const read = async (runId: string, scheduleId = 'TEST-schedule') => {
    const result = await rpc('schedule.run.read', { runId, scheduleId }); assert.equal(result.ok, true);
    return result.value;
  };
  return { root, profile, binding, contexts, sessions, order, opens: () => opens, rpc, read, request,
    confirmOriginalCleanup() { cleanupUnknown = false; },
    async restart() { assert.equal((await host.dispose()).cleanup, 'completed'); host = open(); await raw('host.handshake', { protocolVersion: 1 }); },
    dispose: () => host.dispose() };
}

test('finite Host run keeps scheduled choices, one input and original outcome across replay and cold restart', async t => {
  const f = await fixture(t), request = f.request('TEST-finite');
  assert.equal((await f.rpc('schedule.run.start', request, request.runId)).ok, true);
  await until(() => f.sessions[0]?.inputs.length === 1);
  const context = f.contexts[0]!;
  assert.equal(context.profile.model, 'TEST-selected-model');
  assert.equal(context.profile.accountBinding, 'PRIVATE-account');
  assert.equal(context.profile.provider, 'claude');
  if (context.profile.provider !== 'claude') assert.fail();
  assert.equal(context.profile.nativeOptions?.effort, 'low');
  assert.equal(context.profile.nativeOptions?.permissionMode, 'default');
  assert.deepEqual(context.profile.extraArgs, ['--max-turns', '2', '--max-budget-usd', '0.5']);
  assert.deepEqual(context.disallowedTools, ['Bash']);
  assert.deepEqual(context.profile.autoAllowedTools, ['Read']);
  assert.equal('endpoint' in context, false); assert.equal('connection' in context, false);
  assert.equal(f.sessions[0]!.inputs[0]!.content, request.config.prompt);
  const nativeInput = f.sessions[0]!.inputs[0]!;
  const authorization = { sessionRef: f.sessions[0]!.sessionRef, inputId: nativeInput.inputId,
    operationRef: nativeInput.operationRef, parentToolRef: 'TEST-parent-tool', signal: new AbortController().signal };
  assert.equal(await context.subagents?.authorize(authorization), true);
  assert.equal(await context.subagents?.authorize({ ...authorization, inputId: 'TEST-foreign' }), false);
  assert.equal((await f.rpc('schedule.run.start', request, request.runId)).ok, true);
  assert.equal(f.opens(), 1);
  f.sessions[0]!.finish();
  await until(async () => (await f.read(request.runId))?.phase === 'completed');
  const terminal = await f.read(request.runId);
  assert.equal(terminal?.cleanup, 'confirmed'); assert.equal(terminal?.result?.exitCode, 0);
  assert.equal(terminal?.result?.summary, 'TEST finite model result');
  assert.match(terminal!.result!.stdout, /"type":"assistant"/u);
  assert.match(terminal!.result!.stdout, /"total_cost_usd":0.01/u);
  const blocks = terminal!.result!.stdout.split('\n').flatMap(line => {
    const row = JSON.parse(line) as { message?: { content?: Record<string, unknown>[] } };
    return row.message?.content ?? [];
  });
  assert.deepEqual(blocks.filter(block => ['tool_use', 'tool_result'].includes(String(block.type))), [
    { type: 'tool_use', id: 'TEST-scheduled-tool', name: 'Bash', input: { command: 'TEST command' } },
    { type: 'tool_result', tool_use_id: 'TEST-scheduled-tool', content: 'TEST tool result', is_error: false },
  ]);
  assert.equal(await context.subagents?.authorize(authorization), false);
  assert.equal(JSON.stringify(terminal).includes('PRIVATE-'), false);
  const tasks = await f.rpc('team.tasks.list', {}) as unknown as { value: unknown[] };
  assert.deepEqual(tasks.value, []);
  await f.restart();
  // The retained outcome/latest text survives; cold Runtime truthfully reports its volatile log gap.
  assert.deepEqual(await f.read(request.runId), { ...terminal,
    result: { ...terminal!.result!, stderr: 'Some retained runtime log entries are unavailable.' } });
  assert.equal((await f.rpc('schedule.run.start', request, request.runId)).ok, true);
  assert.equal(f.opens(), 1);
  assert.equal((await f.rpc('schedule.run.start', { ...request, config: { ...request.config, prompt: 'TEST changed' } }, request.runId)).code, 'conflict');
  const next = f.request('TEST-next');
  assert.equal((await f.rpc('schedule.run.start', next, next.runId)).ok, true);
  await until(() => f.sessions[1]?.inputs.length === 1); f.sessions[1]!.finish();
  await until(async () => (await f.read(next.runId))?.phase === 'completed');
  assert.equal(f.opens(), 2);
});

test('cancel before start and during native open never submit; original physical cleanup releases the pending factory', async t => {
  const f = await fixture(t, { blockOpen: true });
  const unseen = f.request('TEST-unseen');
  assert.equal((await f.rpc('schedule.run.cancel', { runId: unseen.runId, scheduleId: unseen.scheduleId })).value?.cleanup, 'confirmed');
  assert.equal((await f.rpc('schedule.run.start', unseen, unseen.runId)).value?.phase, 'interrupted');
  assert.equal(f.opens(), 0);
  const request = f.request('TEST-opening');
  assert.equal((await f.rpc('schedule.run.start', request, request.runId)).ok, true);
  await until(() => f.opens() === 1);
  const cancelled = await f.rpc('schedule.run.cancel', { runId: request.runId, scheduleId: request.scheduleId });
  assert.equal(cancelled.value?.cleanup, 'confirmed');
  assert.equal(f.sessions[0]!.inputs.length, 0);
  assert.ok(f.order.indexOf('original-physical-cleanup') < f.order.indexOf('open-returned'));
  assert.equal(f.sessions[0]!.closes, 1);
  assert.equal((await f.rpc('schedule.run.start', request, request.runId)).value?.phase, 'interrupted');
  assert.equal(f.opens(), 1);
});

test('unknown cleanup is retained and cannot authorize replay or another native occurrence', async t => {
  const f = await fixture(t, { unknown: true }), request = f.request('TEST-held');
  await f.rpc('schedule.run.start', request, request.runId);
  await until(() => f.sessions[0]?.inputs.length === 1); f.sessions[0]!.finish();
  await until(async () => (await f.read(request.runId))?.phase === 'held');
  assert.equal((await f.read(request.runId))?.cleanup, 'unresolved');
  await f.rpc('schedule.run.start', request, request.runId);
  const later = f.request('TEST-after-held'); await f.rpc('schedule.run.start', later, later.runId);
  await until(async () => (await f.read(later.runId))?.phase !== 'running');
  assert.equal(f.opens(), 1);
  assert.equal((await f.dispose()).cleanup, 'failed');
  for (const boundary of ['cancel', 'close']) {
    const recovered = await fixture(t, { physicalUnknown: true }), original = recovered.request('TEST-recover-' + boundary);
    await recovered.rpc('schedule.run.start', original, original.runId);
    await until(() => recovered.sessions[0]?.inputs.length === 1);
    recovered.sessions[0]!.finish();
    await until(async () => (await recovered.read(original.runId))?.phase === 'held');
    recovered.confirmOriginalCleanup();
    if (boundary === 'cancel') {
      const cancelled = await recovered.rpc('schedule.run.cancel', { runId: original.runId, scheduleId: original.scheduleId });
      assert.equal(cancelled.value?.cleanup, 'confirmed');
      assert.equal((await recovered.read(original.runId))?.cleanup, 'confirmed');
      await recovered.rpc('schedule.run.start', original, original.runId);
    }
    assert.equal((await recovered.dispose()).cleanup, 'completed');
    assert.equal(recovered.opens(), 1, 'cleanup recovery never allocates a replacement');
    assert.equal(recovered.sessions[0]!.inputs.length, 1, 'original input is never replayed');
  }
});

test('independent schedules run concurrently and cancelling one preserves the original neighbor', async t => {
  const f = await fixture(t), first = f.request('TEST-parallel-A', 'TEST-schedule-A'),
    second = f.request('TEST-parallel-B', 'TEST-schedule-B');
  for (const input of [first, second]) assert.equal((await f.rpc('schedule.run.start', input, input.runId)).ok, true);
  await until(() => f.sessions.length === 2 && f.sessions.every(session => session.inputs.length === 1));
  const wrong = await f.rpc('schedule.run.cancel', { runId: first.runId, scheduleId: second.scheduleId });
  assert.equal(wrong.code, 'conflict'); assert.equal(f.sessions[0]!.closes, 0);
  const cancelled = await f.rpc('schedule.run.cancel', { runId: first.runId, scheduleId: first.scheduleId });
  assert.equal(cancelled.value?.cleanup, 'confirmed'); assert.equal(f.sessions[1]!.closes, 0);
  assert.equal((await f.read(second.runId, second.scheduleId))?.phase, 'running');
  f.sessions[1]!.finish();
  await until(async () => (await f.read(second.runId, second.scheduleId))?.phase === 'completed');
  assert.equal(f.opens(), 2);
});
