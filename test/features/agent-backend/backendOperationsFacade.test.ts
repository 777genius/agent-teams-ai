// @vitest-environment node
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_INVOKE_CHANNEL,
  AGENT_BACKEND_OPERATIONS_ROUTE,
} from '../../../src/features/agent-backend/contracts';
import {
  BackendOperationsFacade,
  BackendRoutingError,
  HostClientError,
  registerAgentBackendHttp,
  registerAgentBackendIpc,
} from '../../../src/features/agent-backend/main';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const task = {
  id: 'task-1',
  status: 'pending',
  subject: 'A task',
  projectPath: '/private/project',
  nativeSessionId: 'private-native',
};
const create: BackendOperationRequest = {
  handle: { handleId: 'opaque-A' },
  commandId: 'stable-create',
  operation: 'task.create',
  payload: { subject: 'A task' },
};

function setup() {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  const receipt = {
    commandId: create.commandId,
    phase: 'completed',
    command: { operation: create.operation },
    result: task,
    principalId: 'private-principal',
    binding: { storageRoot: '/private/store' },
    fingerprint: 'private-hash',
  };
  router.request.mockResolvedValue({ ok: true, value: receipt });
  return { router, facade: new BackendOperationsFacade(router) };
}

describe('finite captured backend transport facade', () => {
  it('maps actual Team RPC while retaining stable command ID and strips private result fields', async () => {
    const { router, facade } = setup();
    expect(await facade.invoke(create)).toEqual({
      ok: true,
      value: {
        commandId: 'stable-create',
        phase: 'completed',
        operation: 'task.create',
        task: { id: 'task-1', status: 'pending', subject: 'A task' },
      },
    });
    expect(router.request).toHaveBeenCalledExactlyOnceWith(create.handle, {
      commandId: create.commandId,
      method: 'team.execute',
      payload: { operation: 'task.create', payload: { subject: 'A task' } },
      control: false,
    });
  });

  it.each([
    { ...create, method: 'runtime.raw' },
    { ...create, operation: 'runtime.restore' },
    { ...create, handle: { handleId: 'opaque-A', ownerId: 'B' } },
    { ...create, payload: { ...create.payload, binding: { teamId: 'other' } } },
    { ...create, commandId: '' },
    {
      ...create,
      operation: 'runtime.open',
      payload: { memberId: 'member-1', generation: 'spoof' },
    },
    {
      ...create,
      operation: 'runtime.open',
      payload: { memberId: 'member-1', config: { cwd: '/private' } },
    },
    {
      ...create,
      operation: 'runtime.interaction',
      payload: {
        memberId: 'member-1',
        inputId: 'input-1',
        interactionRef: 'request-1',
        reply: { kind: 'permission', decision: 'allow', actor: 'admin' },
      },
    },
  ])('rejects extra authority/native inputs before contacting any owner: %j', async (invalid) => {
    const { router, facade } = setup();
    expect(await facade.invoke(invalid)).toEqual({
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
    expect(router.request).not.toHaveBeenCalled();
    expect(router.lookup).not.toHaveBeenCalled();
  });

  it('routes read and original lookup without executing a new Team command', async () => {
    const { router, facade } = setup();
    router.request.mockResolvedValueOnce({ ok: true, value: [task] });
    expect(await facade.invoke({ ...create, operation: 'tasks.list', payload: {} })).toEqual({
      ok: true,
      value: [{ id: 'task-1', status: 'pending', subject: 'A task' }],
    });
    expect(router.request).toHaveBeenLastCalledWith(create.handle, {
      commandId: create.commandId,
      method: 'team.tasks.list',
      payload: {},
      control: true,
    });
    router.lookup.mockResolvedValueOnce({ ok: true, value: null });
    expect(await facade.invoke({ ...create, operation: 'command.lookup', payload: {} })).toEqual({
      ok: true,
      value: null,
    });
    expect(router.lookup).toHaveBeenCalledExactlyOnceWith(
      create.handle,
      create.commandId,
      'team.lookup'
    );
  });

  it('maps Runtime control to the captured member and strips private native/config/checkpoint state', async () => {
    const { router, facade } = setup();
    router.request.mockResolvedValue({
      ok: true,
      value: {
        memberId: 'member-1',
        phase: 'allocated',
        sealed: false,
        custody: 'owned',
        nativeReady: true,
        attached: true,
        inputs: [{ inputId: 'input-1', phase: 'consumed', operationRef: 'native-op' }],
        interactions: [],
        sessionRef: 'native-session',
        config: { auth: 'secret' },
        binding: { generation: 'private-generation' },
        checkpoints: [{ nativePath: '/private/checkpoint' }],
      },
    });
    const request: BackendOperationRequest = {
      ...create,
      operation: 'runtime.interrupt',
      payload: { memberId: 'member-1', inputId: 'input-1' },
    };
    expect(await facade.invoke(request)).toEqual({
      ok: true,
      value: {
        memberId: 'member-1',
        phase: 'allocated',
        sealed: false,
        custody: 'owned',
        nativeReady: true,
        attached: true,
        inputs: [{ inputId: 'input-1', phase: 'consumed' }],
        interactions: [],
      },
    });
    expect(router.request).toHaveBeenCalledWith(create.handle, {
      commandId: create.commandId,
      method: 'runtime.interrupt',
      payload: request.payload,
      control: true,
    });
  });

  it('rejects mismatched host member/receipt projection as UNKNOWN after a possible effect', async () => {
    const { router, facade } = setup();
    router.request.mockResolvedValueOnce({
      ok: true,
      value: {
        commandId: 'different',
        phase: 'completed',
        command: { operation: 'task.create' },
        result: task,
      },
    });
    expect(await facade.invoke(create)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    router.request.mockResolvedValueOnce({ ok: true, value: { memberId: 'other' } });
    expect(
      await facade.invoke({
        ...create,
        operation: 'runtime.read',
        payload: { memberId: 'member-1' },
      })
    ).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });

  it('retains UNKNOWN loss and original unavailable owner without rerouting or exposing raw errors', async () => {
    const { router, facade } = setup();
    router.request.mockRejectedValueOnce(new HostClientError('request-timeout', 'unknown'));
    expect(await facade.invoke(create)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    router.request.mockRejectedValueOnce(new BackendRoutingError('unavailable'));
    expect(await facade.invoke({ ...create, commandId: 'fresh-same-handle' })).toEqual({
      ok: false,
      code: 'unavailable',
      outcome: 'not-dispatched',
    });
    router.request.mockRejectedValueOnce(new Error('private raw provider token'));
    expect(JSON.stringify(await facade.invoke(create))).not.toContain('private raw provider token');
    expect(router.request).toHaveBeenCalledTimes(3);
  });

  it('IPC and HTTP share authorization, strict validation, safe results and teardown', async () => {
    const { router, facade } = setup();
    let handler!: (event: IpcMainInvokeEvent, input: unknown) => Promise<BackendOperationResult>;
    const ipc = {
      handle: vi.fn((_channel, invoke) => {
        handler = invoke;
      }),
      removeHandler: vi.fn(),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    const authorizeIpc = vi.fn(() => true);
    const dispose = registerAgentBackendIpc(ipc, facade, authorizeIpc);
    const app = Fastify();
    const authorizeHttp = vi.fn(() => true);
    registerAgentBackendHttp(app, facade, authorizeHttp);
    try {
      const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
      const ipcResult = await handler(event, create);
      const response = await app.inject({
        method: 'POST',
        url: AGENT_BACKEND_OPERATIONS_ROUTE,
        payload: create,
      });
      expect(response.json()).toEqual(ipcResult);
      expect(authorizeIpc).toHaveBeenCalledWith(event, create);
      expect(authorizeHttp).toHaveBeenCalledOnce();
      expect(ipc.handle).toHaveBeenCalledWith(AGENT_BACKEND_INVOKE_CHANNEL, expect.any(Function));
      router.request.mockClear();
      const invalid = { ...create, storageRoot: '/private/override' };
      expect(await handler(event, invalid)).toEqual({
        ok: false,
        code: 'invalid',
        outcome: 'not-dispatched',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: AGENT_BACKEND_OPERATIONS_ROUTE,
            payload: invalid,
          })
        ).json()
      ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
      expect(router.request).not.toHaveBeenCalled();
      authorizeIpc.mockReturnValue(false);
      authorizeHttp.mockReturnValue(false);
      expect(await handler(event, create)).toEqual({
        ok: false,
        code: 'forbidden',
        outcome: 'not-dispatched',
      });
      expect(
        (
          await app.inject({ method: 'POST', url: AGENT_BACKEND_OPERATIONS_ROUTE, payload: create })
        ).json()
      ).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
      expect(router.request).not.toHaveBeenCalled();
      dispose();
      expect(ipc.removeHandler).toHaveBeenCalledWith(AGENT_BACKEND_INVOKE_CHANNEL);
    } finally {
      await app.close();
    }
  });
});
