import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGraphMemberLogPreviews } from '@features/agent-graph/renderer/hooks/useGraphMemberLogPreviews';

import type { MemberLogPreviewResponse } from '@features/member-log-stream/contracts';

const apiMock = vi.hoisted(() => ({
  memberLogStream: {
    getMemberLogPreviews: vi.fn(),
  },
  teams: {
    onTeamChange: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function response(memberName: string, generatedAt: string): MemberLogPreviewResponse {
  return {
    generatedAt,
    members: [
      {
        memberName,
        items: [
          {
            id: `${memberName}:${generatedAt}`,
            kind: 'text',
            provider: 'claude_transcript',
            timestamp: generatedAt,
            title: 'Assistant',
            preview: memberName,
            tone: 'neutral',
          },
        ],
        coverage: [{ provider: 'claude_transcript', status: 'included' }],
        warnings: [],
        truncated: false,
        overflowCount: 0,
        generatedAt,
      },
    ],
  };
}

const HookProbe = ({
  teamName,
  memberNames,
  laneIdsByMember,
  enabled = true,
  onState,
}: {
  teamName: string;
  memberNames: string[];
  laneIdsByMember?: Record<string, string>;
  enabled?: boolean;
  onState: (state: ReturnType<typeof useGraphMemberLogPreviews>) => void;
}): React.JSX.Element | null => {
  const state = useGraphMemberLogPreviews({
    teamName,
    memberNames,
    laneIdsByMember,
    enabled,
  });
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
};

describe('useGraphMemberLogPreviews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMock.memberLogStream.getMemberLogPreviews.mockReset();
    apiMock.teams.onTeamChange.mockReset();
    apiMock.teams.onTeamChange.mockReturnValue(() => undefined);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('debounces visible member batch requests and passes safe lane ids', async () => {
    apiMock.memberLogStream.getMemberLogPreviews.mockResolvedValue(
      response('alice', '2026-04-03T00:00:00.000Z')
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice', 'alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice' }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({
        maxItemsPerMember: 3,
        textLimit: 200,
        laneIdsByMember: { alice: 'secondary:opencode:alice' },
      })
    );

    act(() => {
      root.unmount();
    });
  });

  it('keeps completed previews cached after the visible member set changes', async () => {
    const aliceLoad = createDeferred<MemberLogPreviewResponse>();
    const bobLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockReturnValueOnce(aliceLoad.promise)
      .mockReturnValueOnce(bobLoad.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const states: ReturnType<typeof useGraphMemberLogPreviews>[] = [];
    const onState = vi.fn((state: ReturnType<typeof useGraphMemberLogPreviews>) => {
      states.push(state);
    });
    const latestState = (): ReturnType<typeof useGraphMemberLogPreviews> | undefined =>
      states.at(-1);

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['alice']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['bob']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      aliceLoad.resolve(response('alice', '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    await act(async () => {
      bobLoad.resolve(response('bob', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('bob')?.items[0]?.preview).toBe('bob');

    act(() => {
      root.unmount();
    });
  });

  it('keeps cached previews while pan or zoom changes the visible member batch', async () => {
    const bobLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockResolvedValueOnce(response('alice', '2026-04-03T00:00:00.000Z'))
      .mockReturnValueOnce(bobLoad.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const states: ReturnType<typeof useGraphMemberLogPreviews>[] = [];
    const onState = vi.fn((state: ReturnType<typeof useGraphMemberLogPreviews>) => {
      states.push(state);
    });
    const latestState = (): ReturnType<typeof useGraphMemberLogPreviews> | undefined =>
      states.at(-1);

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['alice']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={[]} onState={onState} />);
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['bob']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    await act(async () => {
      bobLoad.resolve(response('bob', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('bob')?.items[0]?.preview).toBe('bob');

    act(() => {
      root.unmount();
    });
  });

  it('reloads visible members on log-source events with force refresh', async () => {
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogPreviews.mockResolvedValue(
      response('alice', '2026-04-03T00:00:00.000Z')
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" memberNames={['alice']} onState={() => undefined} />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'log-source-change' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    act(() => {
      root.unmount();
    });
  });
});
