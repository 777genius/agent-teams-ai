import { expect, it, vi } from 'vitest';

import { createHostReviewFlowApi } from '../../../src/features/agent-backend/renderer/createHostReviewFlowApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';
import { isReviewFlowTeamUnavailable } from '../../../src/features/review-flow/renderer/view-model/reviewFlowViewModel';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
import type { ReviewFlowElectronApi } from '../../../src/features/review-flow/contracts/api';
import type { ReviewFlowSettings } from '../../../src/features/review-flow/contracts/types';

const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: '' };
const key = hostTeamSelectionKey('TEST-original');

function fixture() {
  const legacy: ReviewFlowElectronApi = {
    getOverview: vi.fn(async () => ({
      defaults: human,
      overrides: { legacy: human },
      unreadableTeams: [],
      projectTeams: {},
    })),
    setDefaults: vi.fn(async (settings) => settings),
    setTeamOverride: vi.fn(async (_teamName, settings) => settings),
  };
  const originalHandle = { handleId: 'TEST-original' };
  const connections: BackendConnectionSnapshot = {
    state: 'ready',
    bindings: [{ handle: originalHandle, label: 'Captured team', members: [] }],
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => connections),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) =>
      request.operation === 'team.review-flow.read'
        ? { ok: true, value: { kind: 'review-flow', settings: null } }
        : {
            ok: true,
            value: {
              commandId: request.commandId,
              operation: 'task.board.review-flow',
              phase: 'completed',
            },
          }
    ),
  };
  let current = true;
  const api = createHostReviewFlowApi(legacy, backend, () => () => current);
  return {
    api,
    legacy,
    backend,
    connections,
    originalHandle,
    invalidate: () => {
      current = false;
    },
  };
}

it('keeps app defaults with their owner and writes Host overrides only through the captured handle', async () => {
  const f = fixture();
  expect(await f.api.getOverview()).toMatchObject({
    defaults: human,
    overrides: { legacy: human },
    unavailable: [],
  });
  expect(f.backend.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      handle: { handleId: 'TEST-original' },
      operation: 'team.review-flow.read',
      payload: {},
    })
  );
  await f.api.setDefaults(human);
  expect(f.legacy.setDefaults).toHaveBeenCalledWith(human);
  expect(await f.api.setTeamOverride(key, human)).toEqual(human);
  expect(f.backend.invoke).toHaveBeenLastCalledWith(
    expect.objectContaining({
      handle: { handleId: 'TEST-original' },
      operation: 'task.board.review-flow',
      payload: { settings: human },
    })
  );
  expect(f.legacy.setTeamOverride).not.toHaveBeenCalled();
  await f.api.setTeamOverride('legacy', null);
  expect(f.legacy.setTeamOverride).toHaveBeenCalledWith('legacy', null);
});

it('keeps an unavailable Host policy distinct from inheritance and preserves partial owner failures', async () => {
  const f = fixture();
  f.connections.unavailableOwners = [
    {
      kind: 'owner',
      ownerResourceRef: 'TEST-offline-owner',
      code: 'unavailable',
      outcome: 'unknown',
    },
  ];
  vi.mocked(f.backend.invoke).mockResolvedValue({
    ok: false,
    code: 'busy',
    outcome: 'not-dispatched',
  });
  const overview = await f.api.getOverview();
  expect(overview.overrides).toEqual({ legacy: human });
  expect(overview.unavailable).toEqual([
    ...f.connections.unavailableOwners,
    {
      kind: 'team',
      teamName: key,
      displayName: 'Captured team',
      code: 'busy',
      outcome: 'not-dispatched',
    },
  ]);
  expect(isReviewFlowTeamUnavailable({ teamName: key }, overview.unavailable!)).toBe(true);
  expect(
    isReviewFlowTeamUnavailable(
      { teamName: 'saved', ownerResourceRef: 'TEST-offline-owner' },
      overview.unavailable!
    )
  ).toBe(true);
  expect(isReviewFlowTeamUnavailable({ teamName: 'legacy' }, overview.unavailable!)).toBe(false);
});

it.each(['throw', 'unavailable', 'hold'] as const)(
  'looks up the original mutation after %s ACK loss even if the connection list object changes',
  async (failure) => {
    const f = fixture();
    const calls: BackendOperationRequest[] = [];
    vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
      calls.push(structuredClone(request));
      if (request.operation !== 'command.lookup') {
        f.originalHandle.handleId = 'TEST-replacement';
        if (failure === 'throw') throw new Error('lost response');
        return { ok: false, code: failure, outcome: 'unknown' };
      }
      return {
        ok: true,
        value: {
          commandId: request.commandId,
          operation: 'task.board.review-flow',
          phase: 'completed',
        },
      };
    });
    expect(await f.api.setTeamOverride(key, null)).toBeNull();
    expect(calls.map((call) => call.operation)).toEqual([
      'task.board.review-flow',
      'command.lookup',
    ]);
    expect(calls[1]!.commandId).toBe(calls[0]!.commandId);
    expect(calls.map((call) => call.handle.handleId)).toEqual(['TEST-original', 'TEST-original']);
  }
);

it('preserves the original unknown outcome if receipt lookup cannot dispatch', async () => {
  const f = fixture();
  vi.mocked(f.backend.invoke)
    .mockResolvedValueOnce({ ok: false, code: 'unavailable', outcome: 'unknown' })
    .mockResolvedValueOnce({ ok: false, code: 'busy', outcome: 'not-dispatched' });
  await expect(f.api.setTeamOverride(key, human)).rejects.toMatchObject({
    code: 'busy',
    outcome: 'unknown',
  });
  expect(f.backend.invoke).toHaveBeenCalledTimes(2);
});

it.each(['not-dispatched', 'rejected'] as const)(
  'does not look up a definitive %s mutation',
  async (outcome) => {
    const f = fixture();
    vi.mocked(f.backend.invoke).mockResolvedValue({ ok: false, code: 'forbidden', outcome });
    await expect(f.api.setTeamOverride(key, human)).rejects.toMatchObject({
      code: 'forbidden',
      outcome,
    });
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
  }
);

it('refuses a changed context before dispatch and never sends a recovery request after context loss', async () => {
  const before = fixture();
  vi.mocked(before.backend.getConnections).mockImplementation(async () => {
    before.invalidate();
    return before.connections;
  });
  await expect(before.api.setTeamOverride(key, human)).rejects.toMatchObject({
    outcome: 'not-dispatched',
  });
  expect(before.backend.invoke).not.toHaveBeenCalled();
  const after = fixture();
  vi.mocked(after.backend.invoke).mockImplementation(async () => {
    after.invalidate();
    throw new Error('lost response');
  });
  await expect(after.api.setTeamOverride(key, human)).rejects.toMatchObject({ outcome: 'unknown' });
  expect(after.backend.invoke).toHaveBeenCalledTimes(1);
});

it('preserves repairable corrupted overrides and refuses wrong command receipts as unknown', async () => {
  const f = fixture();
  vi.mocked(f.backend.invoke).mockResolvedValueOnce({
    ok: true,
    value: { kind: 'review-flow', settings: null, unreadable: true },
  });
  expect(await f.api.getOverview()).toMatchObject({ unreadableTeams: [key], unavailable: [] });
  vi.mocked(f.backend.invoke).mockResolvedValueOnce({
    ok: true,
    value: {
      commandId: 'TEST-foreign',
      operation: 'task.board.review-flow',
      phase: 'completed',
    },
  });
  await expect(f.api.setTeamOverride(key, human)).rejects.toMatchObject({ outcome: 'unknown' });
});
