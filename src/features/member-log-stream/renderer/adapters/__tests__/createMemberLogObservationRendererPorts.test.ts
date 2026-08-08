import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemberLogObservationRendererPorts } from '../createMemberLogObservationRendererPorts';

import type { MemberLogPreviewResponse } from '../../../contracts';

const apiMock = vi.hoisted(() => ({
  memberLogStream: {
    getMemberLogPreviews: vi.fn(),
    getMemberLogStream: vi.fn(),
    setMemberLogStreamTracking: vi.fn(),
  },
  teams: {
    getLogsForTask: vi.fn(),
    getMemberLogs: vi.fn(),
    onTeamChange: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

describe('createMemberLogObservationRendererPorts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards provider-neutral member preview reads to the renderer API adapter', async () => {
    const previewResponse: MemberLogPreviewResponse = {
      members: [],
      generatedAt: '2026-07-31T00:00:00.000Z',
    };
    apiMock.memberLogStream.getMemberLogPreviews.mockResolvedValue(previewResponse);
    const ports = createMemberLogObservationRendererPorts();
    const options = {
      maxItemsPerMember: 3,
      textLimit: 200,
      laneIdsByMember: { alice: 'secondary:runtime:alice' },
      forceRefresh: true,
    };

    await expect(
      ports.readMemberLogPreviews('alpha-team', ['alice', 'bob'], options)
    ).resolves.toBe(previewResponse);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledWith(
      'alpha-team',
      ['alice', 'bob'],
      options
    );
  });

  it('forwards provider-neutral changes and returns the transport unsubscribe', () => {
    let transportListener:
      | ((event: unknown, change: { teamName: string; type: string }) => void)
      | undefined;
    const transportUnsubscribe = vi.fn();
    apiMock.teams.onTeamChange.mockImplementation((listener) => {
      transportListener = listener;
      return transportUnsubscribe;
    });
    const ports = createMemberLogObservationRendererPorts();
    const listener = vi.fn();

    const unsubscribe = ports.subscribeToChanges(listener);
    transportListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });

    expect(listener).toHaveBeenCalledWith({
      teamName: 'alpha-team',
      type: 'tool-activity',
    });
    unsubscribe();
    expect(transportUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op unsubscribe when the transport omits one', () => {
    apiMock.teams.onTeamChange.mockReturnValue(undefined);
    const ports = createMemberLogObservationRendererPorts();

    const unsubscribe = ports.subscribeToChanges(vi.fn());

    expect(unsubscribe).toEqual(expect.any(Function));
    expect(() => unsubscribe()).not.toThrow();
  });
});
