import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { createHostBackendRenderer } from '../../../src/features/agent-backend/renderer/createHostBackendRenderer';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';

import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '@shared/types/api';
import type { ToolApprovalEvent, ToolApprovalRequest } from '@shared/types/team';

const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});
async function fixture() {
  const handle = { handleId: 'TEST-owner' },
    memberId = 'TEST-alice',
    generation = 'TEST-generation';
  const key = hostTeamSelectionKey(handle.handleId),
    bytes = Buffer.alloc(700_000, 'x');
  const fact = {
    inputId: 'TEST-input',
    interactionRef: 'TEST-ref',
    kind: 'permission' as const,
    phase: 'pending',
    expiresAt: Date.now() + 30_000,
  };
  let corrupt = false;
  const calls: BackendOperationRequest[] = [],
    events: ToolApprovalEvent[] = [];
  const state: BackendRuntimeSnapshot = {
    memberId,
    generation,
    phase: 'allocated',
    custody: 'owned',
    attached: true,
    sealed: false,
    nativeReady: true,
    inputs: [{ inputId: fact.inputId, phase: 'consumed' }],
    interactions: [fact],
  };
  const source: AgentBackendApi = {
    getConnections: async () => ({
      state: 'ready',
      bindings: [{ handle, label: 'TEST team', members: [{ memberId, label: 'alice' }] }],
    }),
    invoke: async (request) => {
      calls.push(request);
      parseBackendOperation(request);
      if (request.operation === 'team.launch.read')
        return {
          ok: true,
          value: {
            launchId: 'TEST-launch',
            rosterRevision: 'TEST-roster',
            status: 'pending',
            expected: 1,
            ready: 0,
            retryCapability: 'same-binding-no-allocation-only',
            members: [
              {
                memberId,
                generation,
                attemptId: 'TEST-attempt',
                status: 'pending-human',
                nativeReady: true,
                usable: false,
                controlAvailable: true,
                noAllocation: false,
                reason: 'human-required',
              },
            ],
          },
        };
      if (request.operation === 'runtime.activity.snapshot')
        return projectBackendResult(request, {
          ok: true,
          value: {
            memberId,
            cursor: 'TEST_cursor',
            retainedFrom: 1,
            events: [],
            hasMore: false,
            state: {
              phase: 'allocated',
              custody: 'owned',
              sealed: false,
              nativeReady: true,
              activeInputs: 1,
              queuedInputs: 0,
              partial: false,
              control: null,
              diagnostic: null,
              interactions: [fact],
            },
            latest: {
              text: [],
              tools: [],
              usage: [],
              compaction: null,
              interactions: [
                {
                  eventId: 'TEST-event',
                  sequence: 1,
                  inputId: fact.inputId,
                  data: {
                    kind: 'interaction',
                    interactionRef: fact.interactionRef,
                    request: {
                      kind: 'permission',
                      tool: 'Write',
                      input: { file_path: '/TEST/captured/value.txt', content: 'TEST next' },
                    },
                  },
                },
              ],
            },
          },
        });
      if (request.operation === 'runtime.read') return { ok: true, value: state };
      if (request.operation === 'runtime.approval.settings.update')
        return projectBackendResult(request, {
          ok: true,
          value: { settings: request.payload.settings },
        });
      if (request.operation === 'runtime.interaction.preview.read') {
        const offset = request.payload.offset,
          end = Math.min(bytes.length, offset + 384 * 1024);
        return projectBackendResult(request, {
          ok: true,
          value: {
            file: {
              attachment: {
                id: 'preview',
                filename: 'preview',
                mimeType: 'text/plain',
                size: bytes.length,
              },
              sha256: createHash('sha256').update(bytes).digest('hex'),
              offset,
              base64: (corrupt
                ? Buffer.alloc(end - offset, 'z')
                : bytes.subarray(offset, end)
              ).toString('base64'),
              nextOffset: end < bytes.length ? end : null,
            },
            sourceFingerprint: 'a'.repeat(64),
            exists: true,
            truncated: false,
            isBinary: false,
          },
        });
      }
      throw new Error('Unexpected effect');
    },
  };
  const legacy = {
    onToolApprovalEvent: () => () => undefined,
    readFileForToolApproval: vi.fn(),
    respondToToolApproval: vi.fn(),
    updateToolApprovalSettings: vi.fn(),
  };
  const { teams: api } = createHostBackendRenderer(
    legacy as unknown as TeamsAPI,
    source,
    () => () => true
  );
  stops.push(api.onToolApprovalEvent((_event, value) => events.push(value)));
  await vi.advanceTimersByTimeAsync(0);
  const request = events.find((event) => 'toolName' in event) as ToolApprovalRequest;
  expect(request).toBeTruthy();
  const scope = { teamName: request.teamName, runId: request.runId, requestId: request.requestId };
  return {
    api,
    key,
    bytes,
    calls,
    legacy,
    scope,
    source,
    events,
    corrupt: () => {
      corrupt = true;
    },
  };
}

it.each(['runtime', 'launch', 'connections'])(
  'keeps the pending approval when optional graph %s observation fails',
  async (failure) => {
    const f = await fixture();
    const invoke = f.source.invoke,
      connections = f.source.getConnections;
    let launchReads = 0,
      finalConnections = false,
      injectedFailures = 0;
    f.source.invoke = async (request) => {
      if (request.operation === 'team.launch.read') launchReads++;
      if (
        (failure === 'runtime' && request.operation === 'runtime.read') ||
        (failure === 'launch' && request.operation === 'team.launch.read' && launchReads === 2)
      ) {
        injectedFailures++;
        throw new Error('TEST optional graph observation unavailable');
      }
      const result = await invoke(request);
      if (request.operation === 'team.launch.read' && launchReads === 2) finalConnections = true;
      return result;
    };
    f.source.getConnections = async () => {
      if (failure === 'connections' && finalConnections) {
        injectedFailures++;
        throw new Error('TEST graph destination read unavailable');
      }
      return connections();
    };
    const changes = vi.fn();
    stops.push(f.api.onTeamChange(changes));
    await f.api.setToolActivityTracking(f.key, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(injectedFailures).toBe(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      requestId: f.scope.requestId,
      teamName: f.key,
      toolName: 'Write',
    });
    expect(changes.mock.calls.some(([_event, event]) => event.type === 'tool-activity')).toBe(
      false
    );
    if (failure === 'runtime') {
      await expect(
        f.api.respondToToolApproval(f.key, f.scope.runId, f.scope.requestId, true)
      ).rejects.toThrow();
      expect(f.calls.some((request) => request.operation === 'runtime.interaction')).toBe(false);
    }
  }
);

it('preserves all five policy preferences through the actual read-order wrapper and finite Main schema', async () => {
  const f = await fixture();
  const settings = {
    autoAllowAll: true,
    autoAllowFileEdits: false,
    autoAllowSafeBash: true,
    timeoutAction: 'deny' as const,
    timeoutSeconds: 17,
  };
  await f.api.updateToolApprovalSettings(f.key, settings);
  expect(f.calls).toContainEqual(
    expect.objectContaining({
      handle: { handleId: 'TEST-owner' },
      operation: 'runtime.approval.settings.update',
      payload: { settings },
    })
  );
  expect(f.legacy.updateToolApprovalSettings).not.toHaveBeenCalled();
});
it('assembles checked captured chunks without invalidating its own read fence or using a local fallback', async () => {
  const f = await fixture();
  expect(await f.api.readFileForToolApproval('/TEST/captured/value.txt', f.scope)).toEqual({
    content: f.bytes.toString(),
    exists: true,
    truncated: false,
    isBinary: false,
  });
  expect(
    f.calls.filter((call) => call.operation === 'runtime.interaction.preview.read')
  ).toHaveLength(2);
  await expect(f.api.readFileForToolApproval('/TEST/captured/value.txt')).rejects.toThrow();
  await expect(
    f.api.readFileForToolApproval('/TEST/captured/value.txt', {
      ...f.scope,
      teamName: 'legacy-TEST-team',
    })
  ).rejects.toThrow();
  await expect(f.api.readFileForToolApproval('/TEST/foreign/value.txt', f.scope)).rejects.toThrow();
  await expect(
    f.api.respondToToolApproval('legacy-TEST-team', f.scope.runId, f.scope.requestId, true)
  ).rejects.toThrow();
  expect(f.legacy.readFileForToolApproval).not.toHaveBeenCalled();
  expect(f.legacy.respondToToolApproval).not.toHaveBeenCalled();
});
it('rejects a corrupted chunk before publishing content or dispatching any native reply', async () => {
  const f = await fixture();
  f.corrupt();
  await expect(
    f.api.readFileForToolApproval('/TEST/captured/value.txt', f.scope)
  ).rejects.toThrow();
  expect(f.legacy.readFileForToolApproval).not.toHaveBeenCalled();
  expect(f.calls.some((call) => call.operation === 'runtime.interaction')).toBe(false);
});
