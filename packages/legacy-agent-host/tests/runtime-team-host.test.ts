import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';

import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { MemberProvider, MemberProviderContext } from '../dist/adapters/providers/ClaudeMemberProvider.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type { CloseReceipt, DriverFactory, Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  assert.fail(message);
}

/** Controlled native boundary only: Team, Runtime, HTTP MCP and NDJSON are real. */
class ControlledSession implements Session {
  readonly sessionRef = 'PRIVATE-native-session';
  readonly submits: Input[] = [];
  closeCalls = 0;
  cleanup: CloseReceipt['cleanup'] = 'confirmed';
  private readonly events: Event[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private readonly progress: () => void;
  constructor(progress: () => void) { this.progress = progress; }
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    return { ok: true, value: { inputId: input.inputId, operationRef: input.operationRef,
      delivery: 'client-consumed', providerAcceptance: 'unknown' } };
  };
  observe = async function* (this: ControlledSession): AsyncIterable<Event> {
    while (!this.ended || this.events.length) {
      const event = this.events.shift();
      if (event) {
        yield event;
        // Like the real provider wrapper, notify only after Runtime persisted the event.
        this.progress();
      } else await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  };
  respondToInteraction: Session['respondToInteraction'] = async () => ({ ok: true, value: undefined });
  interrupt: Session['interrupt'] = async () => ({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  close: Session['close'] = async () => {
    this.closeCalls++;
    this.ended = true;
    this.waiter?.();
    return { logicallyClosed: true, cleanup: this.cleanup };
  };
  emit(event: Event): void { this.events.push(event); this.waiter?.(); this.waiter = undefined; }
  finish(index: number): void {
    const input = this.submits[index];
    assert.ok(input);
    this.emit({ kind: 'result', sessionRef: this.sessionRef, inputId: input.inputId,
      operationRef: input.operationRef, outcome: 'succeeded' });
  }
}

function profile(root: string): TeamHostProfile {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-runtime-host' };
  return {
    schemaVersion: 1,
    owner: { ownerId: binding.backendId, revision: 'revision-1', storageRoot: root,
      profileId: 'TEST-profile', protocolVersion: 1, buildId: 'TEST-runtime-team-host',
      nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    principalId: 'human',
    teams: [{ binding,
      scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
        runId: 'TEST-run', memberId: 'human', generation: '1' },
      members: [
        { memberId: 'alice-id', name: 'alice', role: 'member',
          delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' } },
        { memberId: 'bob-id', name: 'bob', role: 'member' },
      ],
      grants: [
        { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] },
      ],
    }],
    runtime: { members: [{ teamId: binding.teamId, memberId: 'alice-id', principalId: 'alice-session',
      provider: 'claude', sessionId: 'PRIVATE-config-session', generation: 1,
      configRevision: 'PRIVATE-config-revision', cwd: root, model: 'PRIVATE-model',
      accountBinding: 'PRIVATE-account', environment: { HOME: root, TEST_TOKEN: 'PRIVATE-environment-token' },
      executable: { path: '/TEST/nonexistent-no-execution', sha256: 'c'.repeat(64) },
      nativeTools: [], autoAllowedTools: [],
      limits: { queuedInputs: 8, inputBytes: 65536, outputBytes: 65536,
        outputEvents: 256, pendingInteractions: 8, timeoutMs: 1000 },
    }] },
  };
}

async function fixture(t: TestContext, options: {
  changeProfile?(selected: TeamHostProfile): void;
  open?: Promise<Awaited<ReturnType<DriverFactory['open']>>>;
  unknownCleanup?: boolean;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-team-host-')));
  const selected = profile(root);
  options.changeProfile?.(selected);
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: { id: number; result?: unknown; error?: unknown }[] = [];
  let tail = '';
  output.on('data', (chunk: Buffer) => {
    tail += chunk.toString();
    let newline: number;
    while ((newline = tail.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(tail.slice(0, newline)));
      tail = tail.slice(newline + 1);
    }
  });
  const contexts: MemberProviderContext[] = [];
  let session: ControlledSession | undefined;
  let sealed = false;
  let cleanupCalls = 0;
  let opens = 0;
  const host = createTeamHost(selected, { input, output, limits: { disposeTimeoutMs: 2000 } }, {
    createProvider(context): MemberProvider {
      contexts.push(context);
      session = new ControlledSession(context.onProgress);
      if (options.unknownCleanup) session.cleanup = 'unknown';
      return {
        factory: { open: async () => { opens++; return options.open ?? { driver: session!, capabilities: ['session.conversation'] }; } },
        isReady: () => !sealed && context.isCurrent(),
        seal: () => { sealed = true; },
        cleanup: async () => { cleanupCalls++; return !options.unknownCleanup; },
      };
    },
  });
  t.after(async () => {
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const binding = { schemaVersion: 1, handleId: 'TEST-handle', owner: selected.owner, scope: selected.teams[0]!.scope };
  let sequence = 0;
  function send(method: string, params: unknown): number {
    const id = ++sequence;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }
  async function answer(id: number): Promise<unknown> {
    await eventually(() => frames.some((frame) => frame.id === id), `RPC ${id} must answer`);
    const frame = frames.find((candidate) => candidate.id === id)!;
    assert.equal(frame.error, undefined);
    return frame.result;
  }
  const rpc = async (method: string, payload: unknown, overrides = {}) => answer(send(method, {
    commandId: `rpc-${sequence + 1}`, binding, payload, ...overrides,
  }));
  await answer(send('host.handshake', { protocolVersion: 1 }));
  const runtimeBinding: RuntimeBinding = { backendId: selected.owner.ownerId, teamId: binding.scope.teamId,
    runId: binding.scope.runId, memberId: 'alice-id', generation: '1' };
  return { root, selected, binding, host, contexts, frames, send, answer, rpc, runtimeBinding,
    session: () => { assert.ok(session); return session; },
    sealed: () => sealed, opens: () => opens, cleanupCalls: () => cleanupCalls };
}

async function tool(context: MemberProviderContext, name: string, args: Record<string, unknown>) {
  const response = await fetch(context.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${context.endpoint.bearerToken}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'TEST-tool', method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(typeof body.result.content[0]?.text, 'string');
  const value: unknown = JSON.parse(body.result.content[0]!.text);
  return { status: response.status, result: { isError: body.result.isError, value } };
}

test('NDJSON human messages auto-admit once and terminal events pump the next input without dispatch RPC', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const message = { operation: 'message.send', payload: { to: 'alice', text: 'first human message' } };
  const first = await f.rpc('team.execute', message, { commandId: 'human-first' }) as { ok: boolean; value: CommandReceipt };
  assert.equal(first.ok, true);
  assert.equal(first.value.phase, 'completed');
  assert.equal(f.opens(), 0, 'message admission does not allocate a provider implicitly');
  assert.deepEqual(await f.rpc('team.execute', message, { commandId: 'human-first' }), first);
  assert.equal((await f.rpc('runtime.open', { memberId: 'alice-id' }) as { ok: boolean }).ok, true);
  await eventually(() => f.session().submits.length === 1, 'open must kick pending human delivery');
  await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'alice', text: 'second human message' } });
  await tick();
  assert.equal(f.session().submits.length, 1, 'second prompt must await the first terminal');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2, 'persisted result must kick the next input');
  assert.deepEqual(f.session().submits.map((input) => input.content), ['first human message', 'second human message']);
  assert.equal(f.session().submits[0]?.inputId, first.value.effects.deliveryId);
  assert.notEqual(f.session().submits[0]?.operationRef, f.session().submits[1]?.operationRef);
  f.session().finish(1);
  await tick();
  const state = await f.rpc('runtime.read', { memberId: 'alice-id' }) as { value: { inputs: { phase: string }[] } };
  assert.deepEqual(state.value.inputs.map((row) => row.phase), ['terminal', 'terminal']);
  assert.equal(f.opens(), 1);
  assert.equal(f.session().submits.length, 2);
});

test('member HTTP MCP and Desktop transport share canonical Tasks and enforce member/scope authority', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.rpc('runtime.open', { memberId: 'alice-id' });
  const context = f.contexts[0]!;
  const created = await tool(context, 'task_create', { commandId: 'alice-task', subject: 'MCP canonical Task', owner: 'alice' });
  assert.equal(created.status, 200);
  const receipt = created.result.value as CommandReceipt;
  assert.equal(receipt.phase, 'completed');
  assert.equal(receipt.principalId, 'alice-session');
  const started = await tool(context, 'task_start', { commandId: 'alice-start', taskId: receipt.effects.taskId });
  assert.equal((started.result.value as CommandReceipt).phase, 'completed');
  const task = await f.rpc('team.task.get', { taskId: receipt.effects.taskId }) as { value: { owner: string; status: string } };
  assert.equal(task.value.owner, 'alice');
  assert.equal(task.value.status, 'in_progress');
  const taskPath = join(f.root, 'tasks', 'test-runtime-host', `${receipt.effects.taskId}.json`);
  const before = readFileSync(taskPath, 'utf8');
  const forged = await tool(context, 'task_start', { commandId: 'forged-member', taskId: receipt.effects.taskId, memberId: 'bob-id' });
  assert.deepEqual(forged.result.value, { error: { code: 'invalid' } });
  assert.equal(readFileSync(taskPath, 'utf8'), before);
  assert.deepEqual(await f.rpc('runtime.open', { memberId: 'bob-id' }), { ok: false, code: 'invalid', outcome: 'rejected' });
  assert.deepEqual(await f.rpc('runtime.read', { memberId: 'alice-id' }, {
    binding: { ...f.binding, scope: { ...f.binding.scope, runId: 'forged-run' } },
  }), { ok: false, code: 'forbidden', outcome: 'rejected' });
  const other = await f.rpc('team.execute', { operation: 'task.create', payload: { subject: 'Bob task', owner: 'bob' } }) as { value: CommandReceipt };
  const wrong = await tool(context, 'task_start', { commandId: 'wrong-assignee', taskId: other.value.effects.taskId });
  assert.equal(wrong.result.isError, true);
  assert.equal((wrong.result.value as CommandReceipt).phase, 'rejected');
  assert.equal(f.opens(), 1);
});

test('runtime projections redact private provider identities; missing human control and revoked member grants refuse allocation', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.rpc('runtime.open', { memberId: 'alice-id' });
  await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'alice', text: 'interaction prompt' } });
  await eventually(() => f.session().submits.length === 1, 'human prompt must dispatch');
  const input = f.session().submits[0]!;
  f.session().emit({ kind: 'interaction', sessionRef: f.session().sessionRef,
    inputId: input.inputId, operationRef: input.operationRef, interactionRef: 'safe-interaction',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} } });
  await tick();
  const view = await f.rpc('runtime.read', { memberId: 'alice-id' }) as { value: { interactions: unknown[] } };
  assert.equal(view.value.interactions.length, 1);
  const serialized = JSON.stringify(f.frames);
  for (const secret of ['PRIVATE-native-session', 'PRIVATE-config-session', 'PRIVATE-config-revision',
    'PRIVATE-account', 'PRIVATE-environment-token', 'PRIVATE-model', f.contexts[0]!.endpoint.bearerToken,
    f.contexts[0]!.endpoint.url, input.operationRef, f.root])
    assert.equal(serialized.includes(secret), false, `public frames must omit ${secret}`);
  for (const denied of ['human-control', 'revoked-member'] as const) {
    const restricted = await fixture(t, { changeProfile(selected) {
      if (denied === 'human-control') selected.teams[0]!.grants[0]!.permissions = ['read'];
      else selected.teams[0]!.grants[1]!.revoked = true;
    } });
    const opened = await restricted.rpc('runtime.open', { memberId: 'alice-id' }) as { ok: boolean };
    assert.equal(opened.ok, false, denied);
    assert.equal(restricted.opens(), 0, 'authority failure must precede provider creation');
  }
});

test('dispose seals a pending provider open before late allocation and retains unknown custody as cleanup debt', { timeout: 10000 }, async (t) => {
  const opening = deferred<Awaited<ReturnType<DriverFactory['open']>>>();
  const f = await fixture(t, { open: opening.promise, unknownCleanup: true });
  f.send('runtime.open', { commandId: 'pending-open', binding: f.binding, payload: { memberId: 'alice-id' } });
  await eventually(() => f.opens() === 1, 'provider factory must be pending');
  const closing = f.host.dispose();
  assert.equal(f.sealed(), true, 'seal must occur synchronously, before late allocation');
  assert.equal(f.contexts[0]!.isCurrent(), false);
  opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
  assert.deepEqual(await closing, { reason: 'disposed', cleanup: 'failed' });
  assert.equal(f.session().submits.length, 0);
  assert.ok(f.session().closeCalls >= 1, 'late native allocation must enter owned cleanup');
  assert.equal(f.cleanupCalls(), 1);
  const record = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, (tx) => tx.get());
  assert.equal(record?.sealed, true);
  assert.notEqual(record?.phase, 'closed', 'cleanup debt must never become definitive closed');
  assert.equal(record?.custody, 'unknown', 'unknown close must survive host disposal');
  assert.equal(f.opens(), 1);
});

test('expired MCP proof holds the next admitted input; disposing a never-opened profile performs no allocation', { timeout: 10000 }, async (t) => {
  const untouched = await fixture(t);
  assert.deepEqual(await untouched.host.dispose(), { reason: 'disposed', cleanup: 'completed' });
  assert.equal(untouched.opens(), 0);
  assert.equal(untouched.contexts.length, 0);
  assert.equal(untouched.cleanupCalls(), 0);

  const f = await fixture(t, { changeProfile(selected) { selected.runtime!.members[0]!.mcpLifetimeMs = 1000; } });
  const opened = await f.rpc('runtime.open', { memberId: 'alice-id' }) as { value: { nativeReady: boolean } };
  assert.equal(opened.value.nativeReady, true);
  await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'alice', text: 'before expiry' } });
  await eventually(() => f.session().submits.length === 1, 'valid proof must allow the first prompt');
  f.session().finish(0);
  await tick();
  await delay(1100);
  assert.equal(f.contexts[0]!.isCurrent(), false, 'the actual endpoint lifetime must expire');
  const sent = await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'alice', text: 'after expiry' } }) as { ok: boolean };
  assert.equal(sent.ok, true, 'expired native dependency must not erase the business message');
  await f.rpc('runtime.dispatch', { memberId: 'alice-id' });
  const view = await f.rpc('runtime.read', { memberId: 'alice-id' }) as {
    value: { nativeReady: boolean; inputs: { phase: string }[] };
  };
  assert.equal(view.value.nativeReady, false);
  assert.deepEqual(view.value.inputs.map((row) => row.phase), ['terminal', 'admitted']);
  assert.equal(f.session().submits.length, 1, 'stale MCP readiness must not reach SPI.submit');
  assert.equal(f.opens(), 1, 'dependency expiry must not create a replacement session');
});
