import {
  createTeamRuntimeOperationsRendererSlice,
  type TeamRuntimeOperationsRefreshActions,
} from '@features/team-runtime-operations/renderer';
import { createTeamRuntimeOperationsTransport } from '@renderer/composition/team/createTeamRuntimeOperationsTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  restartMember: vi.fn(),
  retryFailedOpenCodeSecondaryLanes: vi.fn(),
  skipMemberForLaunch: vi.fn(),
  unwrapIpc: vi.fn(async <T>(_operation: string, action: () => Promise<T>): Promise<T> => action()),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      restartMember: apiMocks.restartMember,
      retryFailedOpenCodeSecondaryLanes: apiMocks.retryFailedOpenCodeSecondaryLanes,
      skipMemberForLaunch: apiMocks.skipMemberForLaunch,
    },
  },
}));

vi.mock('@renderer/utils/unwrapIpc', () => ({ unwrapIpc: apiMocks.unwrapIpc }));

function createHarness() {
  const trace: string[] = [];
  const actions: TeamRuntimeOperationsRefreshActions = {
    fetchMemberSpawnStatuses: vi.fn(async () => {
      trace.push('refresh:spawn');
    }),
    fetchTeamAgentRuntime: vi.fn(async () => {
      trace.push('refresh:runtime');
    }),
    fetchTeams: vi.fn(async () => {
      trace.push('refresh:teams');
    }),
    refreshTeamMessagesHead: vi.fn(async () => {
      trace.push('refresh:messages');
    }),
  };
  const retryResult = {
    attempted: ['alice'],
    confirmed: [],
    failed: [],
    pending: [],
    skipped: [],
  };
  const transport = {
    restartMember: vi.fn(async () => {
      trace.push('transport:restart');
    }),
    retryFailedSecondaryLanes: vi.fn(async () => {
      trace.push('transport:retry');
      return retryResult;
    }),
    skipMemberForLaunch: vi.fn(async () => {
      trace.push('transport:skip');
    }),
  };
  const slice = createTeamRuntimeOperationsRendererSlice({
    actions: { getActions: () => actions },
    transport,
  });
  return { actions, retryResult, slice, trace, transport };
}

describe('createTeamRuntimeOperationsRendererSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves each runtime command refresh set', async () => {
    const restart = createHarness();
    await restart.slice.restartMember('sandbox-team', 'alice');
    expect(restart.trace).toEqual([
      'transport:restart',
      'refresh:messages',
      'refresh:spawn',
      'refresh:runtime',
    ]);

    const retry = createHarness();
    await expect(retry.slice.retryFailedRuntimeLanes('sandbox-team')).resolves.toBe(
      retry.retryResult
    );
    expect(retry.trace).toEqual(['transport:retry', 'refresh:spawn', 'refresh:runtime']);

    const skip = createHarness();
    await skip.slice.skipMemberForLaunch('sandbox-team', 'alice');
    expect(skip.trace).toEqual([
      'transport:skip',
      'refresh:spawn',
      'refresh:runtime',
      'refresh:teams',
    ]);
  });

  it('runs all best-effort refreshes in finally and preserves the command rejection', async () => {
    const harness = createHarness();
    const failure = new Error('restart failed');
    harness.transport.restartMember.mockRejectedValueOnce(failure);
    vi.mocked(harness.actions.fetchMemberSpawnStatuses).mockRejectedValueOnce(
      new Error('spawn refresh failed')
    );

    await expect(harness.slice.restartMember('sandbox-team', 'alice')).rejects.toBe(failure);
    expect(harness.actions.refreshTeamMessagesHead).toHaveBeenCalledWith('sandbox-team');
    expect(harness.actions.fetchMemberSpawnStatuses).toHaveBeenCalledWith('sandbox-team');
    expect(harness.actions.fetchTeamAgentRuntime).toHaveBeenCalledWith('sandbox-team');
  });

  it('keeps the legacy Desktop retry API behind a generic renderer transport port', async () => {
    apiMocks.restartMember.mockResolvedValueOnce(undefined);
    apiMocks.retryFailedOpenCodeSecondaryLanes.mockResolvedValueOnce({
      attempted: [],
      confirmed: [],
      failed: [],
      pending: [],
      skipped: [],
    });
    apiMocks.skipMemberForLaunch.mockResolvedValueOnce(undefined);
    const transport = createTeamRuntimeOperationsTransport();

    await transport.restartMember('sandbox-team', 'alice');
    await transport.retryFailedSecondaryLanes('sandbox-team');
    await transport.skipMemberForLaunch('sandbox-team', 'alice');

    expect(apiMocks.retryFailedOpenCodeSecondaryLanes).toHaveBeenCalledWith('sandbox-team');
    expect(apiMocks.unwrapIpc.mock.calls.map(([operation]) => operation)).toEqual([
      'team:restartMember',
      'team:retryFailedOpenCodeSecondaryLanes',
      'team:skipMemberForLaunch',
    ]);
  });
});
