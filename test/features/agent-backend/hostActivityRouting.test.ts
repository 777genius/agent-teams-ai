// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it } from 'vitest';

import { createTeamHost } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { initialContextDigest } from '../../../packages/legacy-agent-host/dist/team-launch/context.js';

import type {
  MemberProvider,
  MemberProviderContext,
} from '../../../packages/legacy-agent-host/dist/adapters/providers/MemberProvider.js';
import type { TeamHostProfile } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';

type Session = Awaited<ReturnType<MemberProvider['factory']['open']>>['driver'];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
});

async function fixture(allowControlledOpen = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-activity-routing-')));
  const binding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    teamName: 'test-activity-routing',
  };
  const scope = {
    projectId: 'TEST-project',
    workspaceId: 'TEST-workspace',
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'human',
    generation: '1',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'human',
    owner: {
      ownerId: binding.backendId,
      revision: 'TEST-revision',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    teams: [
      {
        binding,
        scope,
        members: [
          {
            memberId: 'alice-id',
            name: 'alice',
            role: 'member',
            delivery: { ...binding, runId: scope.runId, memberId: 'alice-id', generation: '1' },
          },
        ],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'admin', 'task.write', 'message.write'],
          },
          {
            principalId: 'alice-session',
            memberName: 'alice',
            permissions: ['read', 'task.write', 'message.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        {
          teamId: binding.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          provider: 'claude',
          sessionId: 'TEST-session',
          generation: 1,
          configRevision: 'TEST-config',
          cwd: root,
          model: 'TEST-model',
          accountBinding: 'TEST-account',
          environment: { HOME: root, CLAUDE_CONFIG_DIR: root },
          executable: { path: '/TEST/no-native-execution', sha256: 'c'.repeat(64) },
          nativeTools: ['Read'],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 1,
            inputBytes: 8192,
            outputBytes: 8192,
            outputEvents: 64,
            pendingInteractions: 2,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
  const input = new PassThrough(),
    output = new PassThrough();
  let sequence = 0,
    tail = '';
  const answers = new Map<number, (value: unknown) => void>();
  output.on('data', (chunk: Buffer) => {
    tail += chunk.toString();
    let index: number;
    while ((index = tail.indexOf('\n')) !== -1) {
      const row = JSON.parse(tail.slice(0, index)) as {
        id: number;
        result?: unknown;
        error?: unknown;
      };
      tail = tail.slice(index + 1);
      answers.get(row.id)?.(row.error ? { error: row.error } : row.result);
      answers.delete(row.id);
    }
  });
  const contexts: MemberProviderContext[] = [];
  const host = createTeamHost(
    profile,
    { input, output, limits: { disposeTimeoutMs: 1000 } },
    {
      createProvider(context) {
        if (!allowControlledOpen) throw new Error('TEST query attempted provider allocation');
        contexts.push(context);
        let finish!: () => void;
        const ended = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const driver: Session = {
          sessionRef: 'TEST-controlled-session',
          submit: async () => ({ ok: false, code: 'unsupported' }),
          observe: async function* () {
            await ended;
            yield* [];
          },
          respondToInteraction: async () => ({ ok: false, code: 'unsupported' }),
          interrupt: async () => ({ ok: false, code: 'unsupported' }),
          checkpoint: () => ({ ok: false, code: 'unsupported' }),
          checkReadiness: async () => ({ ok: true, value: undefined }),
          close: async () => {
            finish();
            return { logicallyClosed: true, cleanup: 'confirmed' };
          },
        };
        return {
          factory: {
            open: async () => ({ driver, capabilities: [...context.request.requiredCapabilities] }),
          },
          isReady: () => true,
          initialContextEvidence: () => ({
            kind: 'native-configuration',
            contextDigest: initialContextDigest(context.instructions),
            generation: context.endpoint.binding.generation,
            configRevision: context.request.configRevision,
          }),
          seal() {},
          cleanup: async () => true,
        };
      },
    }
  );
  cleanups.push(async () => {
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const envelope = { schemaVersion: 1, handleId: 'TEST-handle', owner: profile.owner, scope };
  function send(method: string, params: unknown) {
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TEST unanswered RPC ${method}`)), 2000);
      answers.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const rpc = (method: string, payload: unknown, selected = envelope) =>
    send(method, { commandId: `TEST-command-${sequence + 1}`, binding: selected, payload });
  await send('host.handshake', { protocolVersion: 1 });
  return { rpc, envelope, contexts };
}

it('routes actual Team Logs/Stats envelopes before member parsing without allocating a provider', async () => {
  const f = await fixture();
  expect(await f.rpc('team.activity.logs.read', { memberName: 'alice' })).toMatchObject({
    ok: true,
    value: {
      kind: 'team-activity-logs',
      logs: [{ memberName: 'alice', generation: '1', events: [] }],
    },
  });
  expect(await f.rpc('team.activity.stats.read', { memberName: 'alice' })).toMatchObject({
    ok: true,
    value: {
      kind: 'team-activity-stats',
      stats: {
        memberName: 'alice',
        generations: 1,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
    },
  });
  const created = (await f.rpc('team.execute', {
    operation: 'task.create',
    payload: { subject: 'TEST activity scope', owner: 'alice' },
  })) as { value: { effects: { taskId: string } } };
  const taskId = created.value.effects.taskId;
  expect(await f.rpc('team.activity.logs.read', { taskId })).toMatchObject({
    ok: true,
    value: { kind: 'team-activity-logs', logs: [{ taskId, events: [] }] },
  });
  expect(f.contexts).toEqual([]);
});

it('refuses wrong original Team scope and ambiguous or wrong-kind query selectors', async () => {
  const f = await fixture();
  for (const [method, payload] of [
    ['team.activity.logs.read', { memberName: 'alice', taskId: 'TEST-task' }],
    ['team.activity.stats.read', { taskId: 'TEST-task' }],
    ['team.activity.logs.read', { memberName: 'missing' }],
  ] as const)
    expect(await f.rpc(method, payload)).toMatchObject({
      ok: false,
      code: 'invalid',
      outcome: 'rejected',
    });
  expect(
    await f.rpc(
      'team.activity.logs.read',
      { memberName: 'alice' },
      { ...f.envelope, scope: { ...f.envelope.scope, teamId: 'TEST-other-team' } }
    )
  ).toMatchObject({ ok: false, code: 'forbidden' });
  expect(f.contexts).toEqual([]);
});

it('passes the ordinary subagent port through the actual coordinator provider seam', async () => {
  const f = await fixture(true);
  expect(await f.rpc('runtime.open', { memberId: 'alice-id' })).toMatchObject({ ok: true });
  expect(f.contexts).toHaveLength(1);
  expect(f.contexts[0]).toMatchObject({ subagents: { mode: 'do', tools: ['Read'] } });
  expect(Object.keys(f.contexts[0]!.connection.process!).sort()).toEqual(['list', 'lookup', 'metadata', 'register']);
  expect(Object.isFrozen(f.contexts[0]!.connection.process)).toBe(true);
  expect(f.contexts[0]!.connection.crossTeam).toBeDefined();
});

it('keeps real Team snapshot/feed/roster and runtime lifecycle unchanged across private policy preference updates', async () => {
  const f = await fixture();
  const read = () =>
    Promise.all([
      f.rpc('team.snapshot', {}),
      f.rpc('team.roster.read', {}),
      f.rpc('runtime.read', { memberId: 'alice-id', expectedGeneration: '1' }),
    ]);
  const before = await read();
  expect(before).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
  const settings = {
    autoAllowAll: true,
    autoAllowFileEdits: true,
    autoAllowSafeBash: true,
    timeoutAction: 'deny',
    timeoutSeconds: 17,
  };
  expect(await f.rpc('runtime.approval.settings.update', { settings })).toEqual({
    ok: true,
    value: { settings },
  });
  expect(await f.rpc('runtime.approval.settings.read', {})).toEqual({
    ok: true,
    value: { settings },
  });
  expect(await read()).toEqual(before);
  expect(f.contexts).toEqual([]);
});
