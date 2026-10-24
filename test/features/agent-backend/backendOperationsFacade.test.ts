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
  it('validates ordinary Task creation choices and projects separate prompt refs without private fields', async () => {
    const { router, facade } = setup();
    const payload = {
      subject: 'TEST immediate',
      owner: 'alice',
      related: ['task-1'],
      prompt: 'TEST separate instructions',
      promptTaskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'test-team' }],
      startImmediately: true,
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: create.commandId,
        phase: 'completed',
        command: { operation: 'task.create' },
        result: { ...task, ...payload, status: 'in_progress' },
      },
    });
    expect(await facade.invoke({ ...create, payload })).toEqual({
      ok: true,
      value: {
        commandId: create.commandId,
        phase: 'completed',
        operation: 'task.create',
        task: {
          id: task.id,
          subject: payload.subject,
          status: 'in_progress',
          owner: 'alice',
          related: ['task-1'],
          prompt: payload.prompt,
          promptTaskRefs: payload.promptTaskRefs,
        },
      },
    });
    expect(router.request).toHaveBeenCalledWith(
      create.handle,
      expect.objectContaining({
        method: 'team.execute',
        payload: { operation: 'task.create', payload },
      })
    );
    router.request.mockClear();
    for (const invalid of [
      { ...payload, startImmediately: 'true' },
      { ...payload, related: [1] },
    ])
      expect(await facade.invoke({ ...create, payload: invalid })).toEqual({
        ok: false,
        code: 'invalid',
        outcome: 'not-dispatched',
      });
    expect(router.request).not.toHaveBeenCalled();
  });

  it('accepts only explicit null or a name for clear-assignee through the same Task owner', async () => {
    const { router, facade } = setup();
    const request = {
      ...create,
      operation: 'task.assign' as const,
      payload: { taskId: task.id, owner: null },
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: create.commandId,
        phase: 'completed',
        command: { operation: 'task.assign' },
        result: task,
      },
    });
    expect(await facade.invoke(request)).toMatchObject({
      ok: true,
      value: { operation: 'task.assign', task: { id: task.id } },
    });
    expect(router.request).toHaveBeenCalledWith(
      create.handle,
      expect.objectContaining({ payload: { operation: 'task.assign', payload: request.payload } })
    );
    router.request.mockClear();
    expect(await facade.invoke({ ...request, payload: { taskId: task.id } })).toEqual({
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
    expect(router.request).not.toHaveBeenCalled();
  });

  it('exposes durable probe absence only for original read, never as a successful start or cancel', async () => {
    const { router, facade } = setup();
    router.request.mockResolvedValue({ ok: true, value: null });
    const request = {
      handle: create.handle,
      commandId: 'TEST-original-probe',
      payload: {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'alice',
        model: 'opus',
      },
    };
    expect(await facade.invoke({ ...request, operation: 'team.launch.probe.read' })).toEqual({
      ok: true,
      value: null,
    });
    for (const operation of ['team.launch.probe.start', 'team.launch.probe.cancel'] as const)
      expect(await facade.invoke({ ...request, operation })).toMatchObject({
        ok: false,
        code: 'hold',
        outcome: 'unknown',
      });
  });
  it('routes a Team-qualified model intent and its original controls without leaking native selections', async () => {
    const { router, facade } = setup();
    const payload = {
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-roster',
      memberId: 'alice',
      model: 'opus',
      effort: 'medium' as const,
      context: 'model-default' as const,
    };
    const value = {
      ...payload,
      commandId: 'TEST-probe',
      phase: 'completed',
      ok: true,
      expiresAt: Date.now() + 60000,
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        ...value,
        profileId: 'PRIVATE-profile',
        accountBinding: 'PRIVATE-account',
        environment: { HOME: '/PRIVATE-home' },
      },
    });
    for (const operation of [
      'team.launch.probe.start',
      'team.launch.probe.read',
      'team.launch.probe.cancel',
    ] as const) {
      const request = { handle: create.handle, commandId: value.commandId, operation, payload };
      expect(await facade.invoke(request)).toEqual({ ok: true, value });
      expect(router.request).toHaveBeenLastCalledWith(
        create.handle,
        expect.objectContaining({
          commandId: value.commandId,
          method: operation,
          payload,
          control: operation !== 'team.launch.probe.start',
        })
      );
    }
    router.request.mockClear();
    expect(
      await facade.invoke({
        handle: create.handle,
        commandId: value.commandId,
        operation: 'team.launch.probe.start',
        payload: { ...payload, profileId: 'PRIVATE-override' },
      })
    ).toMatchObject({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(router.request).not.toHaveBeenCalled();
    router.request.mockResolvedValue({
      ok: true,
      value: { ...value, rosterRevision: 'different' },
    });
    expect(
      await facade.invoke({
        handle: create.handle,
        commandId: value.commandId,
        operation: 'team.launch.probe.read',
        payload,
      })
    ).toMatchObject({ ok: false, code: 'hold', outcome: 'unknown' });
  });

  it('validates finite task.start and exposes notification proof without private receipt fields', async () => {
    const { router, facade } = setup();
    const request: BackendOperationRequest = {
      ...create,
      operation: 'task.start',
      payload: { taskId: 'task-1', notification: 'user' },
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        command: { operation: 'task.start' },
        result: { task, notifiedOwner: false },
        taskStartLeadName: 'private-lead',
      },
    });
    expect(await facade.invoke(request)).toEqual({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        operation: 'task.start',
        task: { id: 'task-1', status: 'pending', subject: 'A task' },
        notifiedOwner: false,
      },
    });
    router.request.mockClear();
    expect(
      await facade.invoke({ ...request, payload: { ...request.payload, notification: 'fake' } })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(router.request).not.toHaveBeenCalled();
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        command: { operation: 'task.start' },
        result: { task },
      },
    });
    expect(await facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });

  it('preserves rich message fields and rejects mismatched prepared identity before dispatch', async () => {
    const { router, facade } = setup();
    const request: BackendOperationRequest = {
      handle: { handleId: 'opaque-A' },
      commandId: 'prepared-message',
      operation: 'message.send',
      payload: {
        to: 'alice',
        text: 'Read this',
        messageId: 'prepared-message',
        summary: 'Read-only summary',
        actionMode: 'ask',
        taskRefs: [{ taskId: 'task-1', teamName: 'actual-team', displayId: '1' }],
      },
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        command: { operation: request.operation },
        result: { messageId: request.commandId, deliveryId: 'opaque-delivery' },
      },
    });
    expect(await facade.invoke(request)).toEqual({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        operation: 'message.send',
        messageId: request.commandId,
        deliveryId: 'opaque-delivery',
      },
    });
    expect(router.request).toHaveBeenCalledWith(
      request.handle,
      expect.objectContaining({ payload: { operation: 'message.send', payload: request.payload } })
    );
    router.request.mockClear();
    expect(
      await facade.invoke({ ...request, payload: { ...request.payload, messageId: 'other' } })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(
      await facade.invoke({ ...request, payload: { ...request.payload, actionMode: 'execute' } })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(
      await facade.invoke({ ...request, payload: { ...request.payload, text: '/compact now' } })
    ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    expect(router.request).not.toHaveBeenCalled();
    router.request.mockResolvedValue({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        command: { operation: request.operation },
        result: { messageId: 'wrong-product-message' },
      },
    });
    expect(await facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
  });

  it('keeps IPC response private after captured frame/context changes following dispatch', async () => {
    const { router, facade } = setup();
    let release!: () => void;
    let signal!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.request.mockImplementationOnce(async () => {
      signal();
      await gate;
      return {
        ok: true,
        value: {
          commandId: create.commandId,
          phase: 'completed',
          command: { operation: 'task.create' },
          result: { id: 'private-result', status: 'pending', subject: 'must-not-disclose' },
        },
      };
    });
    let handler!: (event: IpcMainInvokeEvent, input: unknown) => Promise<BackendOperationResult>;
    const ipc = {
      handle: vi.fn((_channel, invoke) => {
        handler = invoke;
      }),
      removeHandler: vi.fn(),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    let frame = 'captured-frame';
    let context = 'captured-context';
    registerAgentBackendIpc(ipc, facade, () => ({
      isCurrent: () => frame === 'captured-frame' && context === 'captured-context',
    }));
    const pending = handler({} as IpcMainInvokeEvent, create);
    await started;
    frame = 'navigated-frame';
    context = 'another-context';
    release();
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'forbidden', outcome: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('must-not-disclose');
    expect(router.request).toHaveBeenCalledTimes(1);
    expect(router.request.mock.calls[0][1].guard?.isCurrent()).toBe(false);
  });

  it('uses the same after-dispatch context guard for HTTP without redispatch', async () => {
    const { router, facade } = setup();
    let release!: () => void;
    let signal!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.request.mockImplementationOnce(async () => {
      signal();
      await gate;
      return {
        ok: true,
        value: {
          commandId: create.commandId,
          phase: 'completed',
          command: { operation: 'task.create' },
          result: task,
        },
      };
    });
    let current = true;
    const app = Fastify();
    registerAgentBackendHttp(app, facade, () => ({ isCurrent: () => current }));
    try {
      const pending = app
        .inject({ method: 'POST', url: AGENT_BACKEND_OPERATIONS_ROUTE, payload: create })
        .then((response) => response.json());
      await started;
      current = false;
      release();
      expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'unknown' });
      expect(router.request).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

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

  it('restores only an explicit checkpoint and source generation through the captured work lane', async () => {
    const { router, facade } = setup();
    const request: BackendOperationRequest = {
      ...create,
      operation: 'runtime.restore',
      payload: {
        memberId: 'member-1',
        reference: 'cp1-' + 'a'.repeat(64),
        expectedGeneration: '1',
      },
    };
    const state = {
      memberId: 'member-1',
      generation: 'restore-next',
      phase: 'allocated',
      sealed: false,
      custody: 'owned',
      nativeReady: true,
      attached: true,
      inputs: [],
      interactions: [],
    };
    router.request.mockResolvedValue({
      ok: true,
      value: { ...state, nativeSessionId: 'PRIVATE-session' },
    });
    expect(await facade.invoke(request)).toEqual({ ok: true, value: state });
    expect(router.request).toHaveBeenCalledExactlyOnceWith(create.handle, {
      commandId: create.commandId,
      method: 'runtime.restore',
      payload: request.payload,
      control: false,
    });
    for (const payload of [
      { memberId: 'member-1', reference: request.payload.reference },
      { ...request.payload, reference: '/private/native-history' },
      { ...request.payload, nativeSessionId: 'PRIVATE-session' },
    ])
      expect(await facade.invoke({ ...request, payload })).toEqual({
        ok: false,
        code: 'invalid',
        outcome: 'not-dispatched',
      });
    expect(router.request).toHaveBeenCalledTimes(1);
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
