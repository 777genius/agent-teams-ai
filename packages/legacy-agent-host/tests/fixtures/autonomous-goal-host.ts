import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';

import { FileRuntimeStore } from '../../dist/adapters/runtime/FileRuntimeStore.js';
import { TeamOwnerStore } from '../../dist/adapters/team/TeamOwnerStore.js';
import { createTeamHost } from '../../dist/composition/TeamHost.js';
import { initialContextDigest } from '../../dist/team-launch/context.js';
import type { MemberProvider, MemberProviderContext } from '../../dist/adapters/providers/MemberProvider.js';
import type { TeamHostProfile } from '../../dist/composition/TeamHost.js';
import type { RuntimeBinding } from '../../dist/runtime/contracts.js';
import type { GoalRecord } from '../../dist/team/goalContracts.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';

export type GoalMember = 'lead' | 'worker';

export async function eventually(check: () => boolean, message: string | (() => string)): Promise<void> {
  // Observation timeout only: production pumps include durable filesystem writes.
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

export function success<T>(result: unknown): T {
  assert.ok(result && typeof result === 'object' && 'ok' in result);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok('value' in result);
  return result.value as T;
}

/** Only the provider boundary is controlled. Host, Runtime, Team, stores and MCP are real. */
export class GoalSession implements Session {
  readonly submits: Input[] = [];
  readonly interrupts: string[] = [];
  private readonly events: Event[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  ready = false;
  sealed = false;
  notifyProgress = true;
  submitAction: Session['submit'] | undefined;
  readonly sessionRef: string;
  private readonly progress: () => void;

  constructor(sessionRef: string, progress: () => void) {
    this.sessionRef = sessionRef;
    this.progress = progress;
  }

  submit: Session['submit'] = async input => {
    this.submits.push(input);
    return this.submitAction ? this.submitAction(input) : {
      ok: true,
      value: { inputId: input.inputId, operationRef: input.operationRef,
        delivery: 'client-consumed', providerAcceptance: 'unknown' },
    };
  };
  observe = async function* (this: GoalSession): AsyncIterable<Event> {
    while (!this.ended || this.events.length) {
      const event = this.events.shift();
      if (event) {
        yield event;
        // The production provider invokes this after Runtime persisted the original event.
        if (this.notifyProgress) this.progress();
      } else await new Promise<void>(resolve => { this.waiter = resolve; });
    }
  };
  respondToInteraction: Session['respondToInteraction'] = async () => ({ ok: true, value: undefined });
  interrupt: Session['interrupt'] = async ref => {
    this.interrupts.push(ref);
    return { ok: true, value: { requested: true, terminal: 'unconfirmed' } };
  };
  checkReadiness: Session['checkReadiness'] = async () => {
    this.ready = true;
    return { ok: true, value: undefined };
  };
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  close: Session['close'] = async () => {
    this.ready = false;
    this.ended = true;
    this.waiter?.();
    return { logicallyClosed: true, cleanup: 'confirmed' };
  };
  emit(event: Event): void {
    this.events.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }
  finish(index: number, outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' = 'succeeded'): void {
    const input = this.submits[index];
    assert.ok(input, `original input ${index} exists`);
    this.emit({ sessionRef: this.sessionRef, inputId: input.inputId,
      operationRef: input.operationRef, kind: 'result', outcome });
  }
}

function profile(root: string, workspace: string, workerWorkspace = workspace): TeamHostProfile {
  const binding = { backendId: 'TEST-goal-backend', teamId: 'TEST-goal-team', teamName: 'test-goal-team' };
  const members = ['lead', 'worker'] as const;
  return {
    schemaVersion: 1,
    owner: { ownerId: binding.backendId, revision: 'revision-1', storageRoot: root,
      profileId: 'TEST-goal-profile', protocolVersion: 1, buildId: 'TEST-goal-host',
      nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    principalId: 'human',
    teams: [{ binding,
      scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
        runId: 'TEST-goal-run', memberId: 'human', generation: '1' },
      members: members.map(name => ({ name, memberId: `${name}-id`,
        role: name === 'lead' ? 'lead' : 'member',
        delivery: { ...binding, runId: 'TEST-goal-run', memberId: `${name}-id`, generation: '1' } })),
      grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
        ...members.map(name => ({ principalId: `${name}-session`, memberName: name,
          permissions: ['read', 'task.write', 'message.write'] as ('read' | 'task.write' | 'message.write')[] }))],
    }],
    runtime: { members: members.map(name => ({
      teamId: binding.teamId, memberId: `${name}-id`, principalId: `${name}-session`,
      provider: 'claude', sessionId: `TEST-${name}-session`, generation: 1,
      configRevision: `TEST-${name}-config`, cwd: name === 'worker' ? workerWorkspace : workspace, model: 'TEST-controlled-model',
      accountBinding: `TEST-${name}-account`,
      environment: { HOME: root, PATH: '/TEST/no-native-execution', CLAUDE_CONFIG_DIR: root },
      executable: { path: '/TEST/nonexistent-no-execution', sha256: 'c'.repeat(64) },
      nativeTools: ['Write'], autoAllowedTools: [],
      limits: { queuedInputs: 8, inputBytes: 65536, outputBytes: 65536,
        outputEvents: 256, pendingInteractions: 8, timeoutMs: 1000 },
    })) },
  };
}

/** Focused subset of the existing runtime-team-host fixture, with independent lead/member sessions. */
export async function goalHost(t: TestContext, options: {
  capture?: boolean;
  workerWorkspace?: 'nested' | 'disjoint';
  solo?: boolean;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-autonomous-goal-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const workerWorkspace = options.workerWorkspace === 'nested' ? join(workspace, 'nested') :
    options.workerWorkspace === 'disjoint' ? join(root, 'worker-workspace') : workspace;
  if (workerWorkspace !== workspace) mkdirSync(workerWorkspace);
  if (options.capture) {
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q'], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  }
  const selected = profile(root, workspace, workerWorkspace);
  if (options.solo) {
    selected.teams[0]!.members = selected.teams[0]!.members.filter(member => member.role === 'lead');
    selected.teams[0]!.grants = selected.teams[0]!.grants.filter(grant => grant.memberName !== 'worker');
    selected.runtime!.members = selected.runtime!.members.filter(member => member.memberId === 'lead-id');
  }
  let input = new PassThrough();
  let output = new PassThrough();
  const frames = new Map<number, { result?: unknown; error?: unknown }>();
  let tail = '';
  const receive = (chunk: Buffer) => {
    tail += chunk.toString();
    let newline: number;
    while ((newline = tail.indexOf('\n')) >= 0) {
      const frame = JSON.parse(tail.slice(0, newline)) as { id: number; result?: unknown; error?: unknown };
      frames.set(frame.id, frame);
      tail = tail.slice(newline + 1);
    }
  };
  output.on('data', receive);
  const contexts = new Map<GoalMember, MemberProviderContext>();
  const sessions = new Map<GoalMember, GoalSession>();
  const restored: unknown[] = [];
  let opens = 0;
  const composition = {
    createProvider(context: MemberProviderContext): MemberProvider {
      const name = context.profile.memberId === 'lead-id' ? 'lead' : 'worker';
      assert.equal(context.profile.memberId, `${name}-id`);
      contexts.set(name, context);
      const session = new GoalSession(`TEST-native-${name}-${opens}`, context.onProgress);
      sessions.set(name, session);
      const current = () => session.ready && !session.sealed && context.isCurrent();
      return {
        factory: { open: async () => {
          opens++;
          if (context.request.checkpointRef)
            restored.push(await context.readCheckpoint(context.request.checkpointRef, context.request));
          return { driver: session, capabilities: [...context.request.requiredCapabilities] };
        } },
        isReady: current,
        initialContextEvidence: () => current() ? {
          kind: 'native-configuration', contextDigest: initialContextDigest(context.instructions),
          generation: context.endpoint.binding.generation, configRevision: context.request.configRevision,
        } : undefined,
        seal: () => { session.sealed = true; },
        cleanup: async () => true,
      };
    },
  };
  let host = createTeamHost(selected, { input, output, limits: { disposeTimeoutMs: 30000 } }, composition);
  t.after(async () => {
    const closed = await host.dispose();
    assert.equal(closed.cleanup, 'completed', 'only disposable TEST sessions are cleaned up');
    rmSync(root, { recursive: true, force: true });
  });
  const binding = { schemaVersion: 1, handleId: 'TEST-goal-handle', owner: selected.owner,
    scope: selected.teams[0]!.scope };
  let sequence = 0;
  const request = async (method: string, params: unknown) => {
    const id = ++sequence;
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    await eventually(() => frames.has(id), `${method} must return its original response`);
    const frame = frames.get(id)!;
    frames.delete(id);
    assert.equal(frame.error, undefined, JSON.stringify(frame.error));
    return frame.result;
  };
  const rpc = (method: string, payload: unknown, commandId = `TEST-command-${sequence + 1}`,
    liveRoster?: { phase: 'capture' | 'read'; remainingMs?: number }) =>
    request(method, { commandId, binding, payload, ...(liveRoster ? { liveRoster } : {}) });
  await request('host.handshake', { protocolVersion: 1 });
  const runtimeStore = new FileRuntimeStore(root);
  const teamStore = new TeamOwnerStore(root, selected.teams[0]!.binding.teamName);
  const runtimeBinding = (name: GoalMember): RuntimeBinding => ({ backendId: selected.owner.ownerId,
    teamId: binding.scope.teamId, runId: binding.scope.runId, memberId: `${name}-id`, generation: '1' });
  let writes = 0;
  return {
    root, workspace, workerWorkspace, selected, rpc, contexts, sessions, restored,
    runtimeStore,
    teamStore,
    goal: () => teamStore.fenced(() => teamStore.read<{ autonomousGoal?: GoalRecord }>('state.json')?.autonomousGoal),
    runtimeBinding,
    runtime: (name: GoalMember) => runtimeStore.fenced(runtimeBinding(name), tx => tx.get()),
    opens: () => opens,
    session(name: GoalMember = 'lead') {
      const value = sessions.get(name);
      assert.ok(value, `${name} has its original provider Session`);
      return value;
    },
    async open(name: GoalMember) { success(await rpc('runtime.open', { memberId: `${name}-id` })); },
    async tool(name: GoalMember, toolName: string, args: Record<string, unknown>) {
      const context = contexts.get(name);
      assert.ok(context);
      const response = await fetch(context.endpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${context.endpoint.bearerToken}`,
          'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'TEST-goal-tool', method: 'tools/call',
          params: { name: toolName, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
      assert.equal(typeof body.result.content[0]?.text, 'string');
      return JSON.parse(body.result.content[0]!.text) as unknown;
    },
    /** Real capture writer and bytes; only the provider's observation callback is controlled. */
    async captureWrite(name: GoalMember, index: number, content: string) {
      assert.equal(options.capture, true, 'the owned disposable Git workspace is enabled');
      const session = sessions.get(name)!;
      const original = session.submits[index]!;
      assert.ok(original);
      const context = contexts.get(name)!;
      await eventually(() => runtimeStore.fenced(context.endpoint.binding, tx =>
        tx.get()?.inputs.find(input => input.intent.inputId === original.inputId)?.phase === 'consumed'),
      'capture starts only after the original input is durably consumed');
      const capture = context.toolEvidence;
      assert.ok(capture?.observeBatch, 'production coordinator supplies the real tool capture port');
      const file = join(context.profile.cwd, `${name}-artifact.txt`);
      const request = { phase: 'before' as const, sessionRef: session.sessionRef,
        inputId: original.inputId, operationRef: original.operationRef,
        toolUseId: `TEST-file-write-${++writes}`, toolName: 'Write',
        toolInput: { file_path: file, content }, signal: new AbortController().signal };
      await capture.observe(request);
      writeFileSync(file, content);
      await capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
      await capture.observeBatch({ ...request, boundary: 'post-tool-use-hooks', tools: [{
        toolUseId: request.toolUseId, toolName: request.toolName,
        toolInput: request.toolInput, outcome: 'succeeded',
      }] });
      return file;
    },
    async restart(expectedHeldInbox?: 'lead') {
      const closed = await host.dispose();
      if (expectedHeldInbox) {
        // An abrupt publication loss leaves an unfinished inbox source. Backup
        // must refuse that image; physical sessions still have to be released.
        assert.equal(closed.cleanup, 'failed');
        const manifest = JSON.parse(readFileSync(join(root, 'backups', 'teams',
          selected.teams[0]!.binding.teamName, 'manifest.json'), 'utf8'));
        assert.deepEqual(manifest.hostOwner.held, [`inboxes/${expectedHeldInbox}.json`]);
        for (const name of ['lead', 'worker'] as const) {
          const runtime = runtimeStore.fenced(runtimeBinding(name), tx => tx.get());
          assert.equal(runtime?.phase, 'closed');
          assert.equal(runtime.custody, 'released');
        }
      } else assert.equal(closed.cleanup, 'completed');
      input = new PassThrough(); output = new PassThrough(); tail = ''; frames.clear();
      output.on('data', receive);
      host = createTeamHost(selected, { input, output, limits: { disposeTimeoutMs: 30000 } }, composition);
      await request('host.handshake', { protocolVersion: 1 });
    },
  };
}
