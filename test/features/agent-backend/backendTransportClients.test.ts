// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_INVOKE_CHANNEL,
  AGENT_BACKEND_OPERATIONS_ROUTE,
} from '../../../src/features/agent-backend/contracts';
import { createAgentBackendBridge } from '../../../src/features/agent-backend/preload';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts';
import type { AgentBackendIpcPort } from '../../../src/features/agent-backend/preload';
import type { AgentBackendHttpPost } from '../../../src/features/agent-backend/renderer';

const request: BackendOperationRequest = Object.freeze({
  handle: Object.freeze({ handleId: 'opaque-retained-handle' }),
  commandId: 'original-command-id',
  operation: 'message.send',
  payload: Object.freeze({ to: 'member-1', text: 'One original intent' }),
});

describe('finite app client adapters', () => {
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
    const invoke = vi.fn<AgentBackendIpcPort['invoke']>().mockResolvedValue(result);
    const post = vi.fn<AgentBackendHttpPost>().mockResolvedValue(result);
    const electron = createAgentBackendBridge({ invoke });
    const http = createAgentBackendHttpClient(post);
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
    const invoke = vi.fn<AgentBackendIpcPort['invoke']>().mockResolvedValue(failure);
    const post = vi.fn<AgentBackendHttpPost>().mockResolvedValue(failure);
    expect(await createAgentBackendBridge({ invoke }).invoke(request)).toBe(failure);
    expect(await createAgentBackendHttpClient(post).invoke(request)).toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not turn lost transport responses into rejection, a replacement ID, or a second dispatch', async () => {
    const loss = new Error('transport response unavailable');
    const invoke = vi.fn<AgentBackendIpcPort['invoke']>().mockRejectedValue(loss);
    const post = vi.fn<AgentBackendHttpPost>().mockRejectedValue(loss);
    await expect(createAgentBackendBridge({ invoke }).invoke(request)).rejects.toBe(loss);
    await expect(createAgentBackendHttpClient(post).invoke(request)).rejects.toBe(loss);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_INVOKE_CHANNEL, request);
    expect(post).toHaveBeenCalledExactlyOnceWith(AGENT_BACKEND_OPERATIONS_ROUTE, request);
  });
});
