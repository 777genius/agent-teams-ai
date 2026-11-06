// @vitest-environment node
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_INVOKE_CHANNEL,
  AGENT_BACKEND_OPERATIONS_ROUTE,
} from '../../../src/features/agent-backend/contracts';
import {
  BackendOperationsFacade,
  registerAgentBackendHttp,
  registerAgentBackendIpc,
} from '../../../src/features/agent-backend/main';
import { createAgentBackendBridge } from '../../../src/features/agent-backend/preload';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main';
import type { AgentBackendIpcPort } from '../../../src/features/agent-backend/preload';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-original-owner' },
  commandId: 'TEST-roster-command',
  operation: 'team.roster.replace',
  payload: {
    expectedRevision: 'a'.repeat(64),
    memberSettingsRelaunch: {
      memberName: 'worker',
      targetKind: 'member',
      expectedFingerprint: 'c'.repeat(64),
      expectedTeamSettingsFingerprint: 'a'.repeat(64),
      baseline: [
        { memberName: 'captain', expectedFingerprint: 'd'.repeat(64) },
        { memberName: 'worker', expectedFingerprint: 'c'.repeat(64) },
      ],
      model: 'TEST-model',
      effort: 'ultra',
    },
    savedSettings: {
      runtimeSelectionVersion: 1,
      cwd: '/TEST/project',
      displayName: 'TEST team',
      prompt: '  TEST prompt\n',
      fastMode: 'off',
      skipPermissions: false,
      syncModelsWithLead: false,
      limitContext: false,
      allowExperimentalLocalModels: false,
      extraCliArgs: ' --TEST="quoted text" ',
    },
    members: [
      {
        name: 'worker',
        role: 'Reviewer',
        workflow: 'TEST instructions',
        isolation: 'worktree',
        cwd: '/TEST/workspace',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'TEST-model',
        effort: 'ultra',
        fastMode: 'off',
        mcpPolicy: {
          mode: 'inheritScopes',
          scopes: { user: false, local: false, project: true },
          serverNames: ['TEST-server'],
        },
      },
    ],
  },
};
function setup() {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  return { router, facade: new BackendOperationsFacade(router) };
}
const saved = () => ({
  revision: 'b'.repeat(64),
  savedSettings: structuredClone(request.payload.savedSettings),
  members: [
    { memberId: 'lead-id', name: 'captain', role: 'lead', settings: {} },
    {
      memberId: 'worker-id',
      name: 'worker',
      role: 'member',
      settings: structuredClone(request.payload.members[0]),
    },
  ],
  removedMembers: [],
});
const okReceipt = () => ({
  ok: true,
  value: {
    commandId: request.commandId,
    revision: 'b'.repeat(64),
    principalId: 'PRIVATE-principal',
    binding: { storageRoot: '/PRIVATE/root' },
  },
});
const wire = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

describe('finite Desktop saved roster facade', () => {
  it('captures the expected original payload for verified control lookup and refuses private selectors', async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    f.router.request.mockImplementation(async () => {
      await gate;
      return okReceipt();
    });
    const input: BackendOperationRequest = {
      ...request,
      operation: 'team.roster.lookup',
      payload: { expected: structuredClone(request.payload) },
    };
    const pending = f.facade.invoke(input);
    input.payload.expected!.members[0].model = 'TEST-mutated';
    input.payload.expected!.memberSettingsRelaunch!.baseline[0].expectedFingerprint = 'f'.repeat(
      64
    );
    release();
    expect(await pending).toMatchObject({ ok: true, value: { commandId: request.commandId } });
    expect(f.router.request).toHaveBeenCalledExactlyOnceWith(request.handle, {
      commandId: request.commandId,
      method: 'team.roster.lookup',
      payload: { expected: request.payload },
      control: true,
    });
    f.router.request.mockClear();
    for (const payload of [
      { expected: { ...request.payload, root: '/PRIVATE' } },
      {
        expected: { ...request.payload, members: [{ name: 'worker', nativeSessionId: 'PRIVATE' }] },
      },
      { expected: undefined },
      { expected: null },
      { principalId: 'PRIVATE' },
    ])
      expect(
        await f.facade.invoke({ ...request, operation: 'team.roster.lookup', payload })
      ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(f.router.request).not.toHaveBeenCalled();
  });

  it('routes strict full replacement to the original owner and returns only original receipt identity', async () => {
    const f = setup();
    f.router.request.mockResolvedValue(okReceipt());
    expect(await f.facade.invoke(request)).toEqual({
      ok: true,
      value: { commandId: request.commandId, revision: 'b'.repeat(64) },
    });
    expect(f.router.request).toHaveBeenCalledExactlyOnceWith(request.handle, {
      commandId: request.commandId,
      method: 'team.roster.replace',
      payload: request.payload,
      control: false,
    });
    expect(f.router.lookup).not.toHaveBeenCalled();
  });
  it('uses control capacity for read/original lookup and accepts authorized absence only on lookup', async () => {
    const f = setup();
    f.router.request.mockResolvedValue(wire({ ok: true, value: saved() }));
    expect(
      (await f.facade.invoke({ ...request, operation: 'team.roster.read', payload: {} })).ok
    ).toBe(true);
    expect(f.router.request).toHaveBeenLastCalledWith(request.handle, {
      commandId: request.commandId,
      method: 'team.roster.read',
      payload: {},
      control: true,
    });
    f.router.request.mockResolvedValue({ ok: true, value: null });
    expect(
      await f.facade.invoke({ ...request, operation: 'team.roster.lookup', payload: {} })
    ).toEqual({ ok: true, value: null });
    expect(f.router.request).toHaveBeenLastCalledWith(request.handle, {
      commandId: request.commandId,
      method: 'team.roster.lookup',
      payload: {},
      control: true,
    });
    expect(f.router.lookup).not.toHaveBeenCalled();
    f.router.request.mockResolvedValue({ ok: true, value: null });
    expect(await f.facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });
  it('captures nested full settings before awaiting and preserves explicit off/false choices', async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    f.router.request.mockImplementation(async () => {
      await gate;
      return okReceipt();
    });
    const input = structuredClone(request);
    const pending = f.facade.invoke(input);
    if (input.operation !== 'team.roster.replace') throw new Error('Wrong fixture');
    input.payload.members[0].workflow = 'TEST-mutated';
    input.payload.members[0].mcpPolicy!.scopes!.user = true;
    input.payload.members[0].mcpPolicy!.serverNames!.push('TEST-mutated');
    input.payload.savedSettings!.prompt = 'TEST-mutated';
    input.payload.savedSettings!.skipPermissions = true;
    input.payload.memberSettingsRelaunch!.baseline[0].expectedFingerprint = 'f'.repeat(64);
    input.payload.memberSettingsRelaunch!.model = 'TEST-mutated';
    release();
    await pending;
    expect(f.router.request.mock.calls[0][1].payload).toEqual(request.payload);
  });
  it('strips private fields at every output level and does not expose native bindings or grant data', async () => {
    const f = setup(),
      value = saved();
    const raw = {
      ...value,
      nativeProfile: 'PRIVATE-profile',
      grants: ['PRIVATE-grant'],
      savedSettings: {
        ...value.savedSettings,
        executable: 'PRIVATE-executable',
        environment: { TOKEN: 'PRIVATE-token' },
      },
      members: value.members.map((member) => ({
        ...member,
        delivery: 'PRIVATE-binding',
        settings: {
          ...member.settings,
          environment: { TOKEN: 'PRIVATE-token' },
          mcpPolicy: {
            mode: 'inheritScopes',
            privateConfig: 'PRIVATE-config',
            scopes: { user: false, project: true, secret: 'PRIVATE-secret' },
          },
        },
      })),
    };
    f.router.request.mockResolvedValue({ ok: true, value: raw });
    const result = await f.facade.invoke({
      ...request,
      operation: 'team.roster.read',
      payload: {},
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    expect(result).toMatchObject({ value: { savedSettings: request.payload.savedSettings } });
    expect(result).toMatchObject({
      value: {
        members: expect.arrayContaining([
          expect.objectContaining({
            settings: expect.objectContaining({
              mcpPolicy: { mode: 'inheritScopes', scopes: { user: false, project: true } },
            }),
          }),
        ]),
      },
    });
  });
  it('rejects malformed and private selectors before any dispatch', async () => {
    const f = setup();
    const members: unknown[] = [
      [{ name: 'worker', memberId: 'lead-id' }],
      [{ name: 'worker', environment: { TOKEN: 'TEST' } }],
      [{ name: 'worker', accountBinding: 'TEST-other' }],
      [{ name: 'worker', generation: 'new' }],
      [{ name: 'worker', effort: 'unsupported' }],
      [{ name: 'worker', fastMode: false }],
      [{ name: 'worker', mcpPolicy: { mode: 'appOnly', scopes: { user: 'false' } } }],
      [{ name: 'worker' }, { name: 'Worker' }],
      Array(1),
    ];
    for (const candidate of members)
      expect(
        await f.facade.invoke({ ...request, payload: { ...request.payload, members: candidate } })
      ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    for (const payload of [
      { ...request.payload, principalId: 'other' },
      { ...request.payload, expectedRevision: 'guess' },
      {
        ...request.payload,
        savedSettings: { cwd: '/TEST/project', environment: { TOKEN: 'TEST' } },
      },
      { ...request.payload, savedSettings: { cwd: '/TEST/project', skipPermissions: 'false' } },
      { ...request.payload, savedSettings: {} },
      {
        ...request.payload,
        memberSettingsRelaunch: {
          ...request.payload.memberSettingsRelaunch,
          principalId: 'TEST-other',
        },
      },
      {
        ...request.payload,
        memberSettingsRelaunch: { ...request.payload.memberSettingsRelaunch, baseline: Array(1) },
      },
      {
        ...request.payload,
        memberSettingsRelaunch: { ...request.payload.memberSettingsRelaunch, model: ' ' },
      },
      {
        ...request.payload,
        members: Array.from({ length: 256 }, (_, i) => ({ name: 'member-' + i })),
      },
    ])
      expect(await f.facade.invoke({ ...request, payload })).toEqual({
        ok: false,
        code: 'invalid',
        outcome: 'not-dispatched',
      });
    expect(f.router.request).not.toHaveBeenCalled();
    expect(f.router.lookup).not.toHaveBeenCalled();
    const oversized = Array.from({ length: 4 }, (_, i) => ({
      name: `worker-${i}`,
      workflow: 'x'.repeat(64 * 1024),
    }));
    expect(
      await f.facade.invoke({ ...request, payload: { ...request.payload, members: oversized } })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(
      await f.facade.invoke({
        ...request,
        payload: Object.create({ expectedRevision: 'a'.repeat(64), members: [] }),
      })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(f.router.request).not.toHaveBeenCalled();
  });
  it('bounds retained output and rejects wrong receipt/duplicate identity without converting uncertainty to rejection', async () => {
    const f = setup();
    f.router.request.mockResolvedValue({
      ok: true,
      value: { commandId: 'wrong', revision: 'b'.repeat(64) },
    });
    expect(await f.facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    const value = saved();
    value.members.push({ ...value.members[0] });
    f.router.request.mockResolvedValue(wire({ ok: true, value }));
    expect(
      await f.facade.invoke({ ...request, operation: 'team.roster.read', payload: {} })
    ).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    const aliased = saved();
    aliased.members[0].memberId = ' lead-id';
    f.router.request.mockResolvedValue(wire({ ok: true, value: aliased }));
    expect(
      await f.facade.invoke({ ...request, operation: 'team.roster.read', payload: {} })
    ).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });
  it('retains original denied/held outcomes and rechecks current context after a response', async () => {
    const f = setup();
    f.router.request.mockResolvedValue({ ok: false, code: 'conflict', outcome: 'rejected' });
    expect(await f.facade.invoke(request)).toEqual({
      ok: false,
      code: 'conflict',
      outcome: 'rejected',
    });
    let current = true;
    f.router.request.mockImplementation(async () => {
      current = false;
      return okReceipt();
    });
    expect(await f.facade.invoke(request, { isCurrent: () => current })).toEqual({
      ok: false,
      code: 'forbidden',
      outcome: 'unknown',
    });
    f.router.request.mockClear();
    expect(await f.facade.invoke(request, { isCurrent: () => false })).toEqual({
      ok: false,
      code: 'forbidden',
      outcome: 'not-dispatched',
    });
    expect(f.router.request).not.toHaveBeenCalled();
  });
  it('uses the same finite operation through preload IPC and authorized HTTP adapters without retries', async () => {
    const f = setup();
    f.router.request.mockResolvedValue(okReceipt());
    let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<BackendOperationResult>;
    const ipc = {
      handle: vi.fn((_channel, callback) => {
        handler = callback;
      }),
      removeHandler: vi.fn(),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    const dispose = registerAgentBackendIpc(ipc, f.facade, () => true);
    const app = Fastify();
    registerAgentBackendHttp(app, f.facade, () => true);
    const bridge = createAgentBackendBridge({
      invoke: ((channel: string, value: BackendOperationRequest) => {
        expect(channel).toBe(AGENT_BACKEND_INVOKE_CHANNEL);
        return handler({} as IpcMainInvokeEvent, value);
      }) as AgentBackendIpcPort['invoke'],
    });
    const http = createAgentBackendHttpClient(
      async (url, payload) => (await app.inject({ method: 'POST', url, payload })).json(),
      async () => ({ state: 'unconfigured', bindings: [] })
    );
    try {
      expect(await http.invoke(request)).toEqual(await bridge.invoke(request));
      expect(f.router.request).toHaveBeenCalledTimes(2);
      expect(AGENT_BACKEND_OPERATIONS_ROUTE).toBe('/api/agent-backend/operations');
    } finally {
      dispose();
      await app.close();
    }
  });
});
