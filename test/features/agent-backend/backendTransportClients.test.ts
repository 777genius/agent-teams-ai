// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_CONNECTIONS_CHANNEL,
  AGENT_BACKEND_CONNECTIONS_ROUTE,
  AGENT_BACKEND_INVOKE_CHANNEL,
  AGENT_BACKEND_OPERATIONS_ROUTE,
} from '../../../src/features/agent-backend/contracts';
import { createAgentBackendBridge } from '../../../src/features/agent-backend/preload';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer';

import type {
  BackendConnectionSnapshot,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts';
import type { AgentBackendIpcPort } from '../../../src/features/agent-backend/preload';
import type { AgentBackendHttpPost } from '../../../src/features/agent-backend/renderer';

const emptyConnections = async (): Promise<BackendConnectionSnapshot> => ({
  state: 'unconfigured',
  bindings: [],
});
type IpcCall = (...args: unknown[]) => Promise<BackendOperationResult | BackendConnectionSnapshot>;
const request: BackendOperationRequest = Object.freeze({
  handle: Object.freeze({ handleId: 'opaque-retained-handle' }),
  commandId: 'original-command-id',
  operation: 'message.send',
  payload: Object.freeze({ to: 'member-1', text: 'One original intent' }),
});

describe('finite app client adapters', () => {
  it('discovers only shell-selected context through fixed no-argument IPC and GET', async () => {
    const connections: BackendConnectionSnapshot = {
      state: 'ready',
      bindings: [{ handle: { handleId: 'opaque-A' }, label: 'Team A', members: [] }],
    };
    const invoke = vi.fn<IpcCall>().mockResolvedValue(connections);
    const get = vi.fn().mockResolvedValue(connections);
    const post = vi.fn<AgentBackendHttpPost>();
    expect(
      await createAgentBackendBridge({
        invoke: invoke as AgentBackendIpcPort['invoke'],
      }).getConnections()
    ).toBe(connections);
    expect(await createAgentBackendHttpClient(post, get).getConnections()).toBe(connections);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_CONNECTIONS_CHANNEL);
    expect(get).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_CONNECTIONS_ROUTE);
    expect(post).not.toHaveBeenCalled();
  });
  it('uses the fixed IPC channel and HTTP route with identical retained handle/command identity', async () => {
    const result: BackendOperationResult = {
      ok: true,
      value: {
        commandId: request.commandId,
        operation: 'message.send',
        phase: 'completed',
        messageId: 'message-1',
        deliveryId: 'delivery-1',
      },
    };
    const invoke = vi.fn<IpcCall>().mockResolvedValue(result);
    const post = vi.fn<AgentBackendHttpPost>().mockResolvedValue(result);
    const electron = createAgentBackendBridge({ invoke: invoke as AgentBackendIpcPort['invoke'] });
    const http = createAgentBackendHttpClient(post, emptyConnections);
    expect(await electron.invoke(request)).toBe(result);
    expect(await http.invoke(request)).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_INVOKE_CHANNEL, request);
    expect(post).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_OPERATIONS_ROUTE, request);
    expect(invoke.mock.calls[0][1]).toBe(request);
    expect(post.mock.calls[0][1]).toBe(request);
  });

  it.each<BackendOperationResult>([
    { ok: false, code: 'hold', outcome: 'unknown' },
    { ok: false, code: 'unavailable', outcome: 'not-dispatched' },
    { ok: false, code: 'forbidden', outcome: 'rejected' },
  ])('preserves the original failure without a new request or fallback: %j', async (failure) => {
    const invoke = vi.fn<IpcCall>().mockResolvedValue(failure);
    const post = vi.fn<AgentBackendHttpPost>().mockResolvedValue(failure);
    expect(
      await createAgentBackendBridge({ invoke: invoke as AgentBackendIpcPort['invoke'] }).invoke(
        request
      )
    ).toBe(failure);
    expect(await createAgentBackendHttpClient(post, emptyConnections).invoke(request)).toBe(
      failure
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not turn lost transport responses into rejection, a replacement ID, or a second dispatch', async () => {
    const loss = new Error('transport response unavailable');
    const invoke = vi.fn<IpcCall>().mockRejectedValue(loss);
    const post = vi.fn<AgentBackendHttpPost>().mockRejectedValue(loss);
    await expect(
      createAgentBackendBridge({ invoke: invoke as AgentBackendIpcPort['invoke'] }).invoke(request)
    ).rejects.toBe(loss);
    await expect(createAgentBackendHttpClient(post, emptyConnections).invoke(request)).rejects.toBe(
      loss
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_INVOKE_CHANNEL, request);
    expect(post).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_OPERATIONS_ROUTE, request);
  });
});
