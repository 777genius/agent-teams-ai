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
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
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

function emptyResponse(memberName: string, generatedAt: string): MemberLogPreviewResponse {
  return {
    generatedAt,
    members: [
      {
        memberName,
        items: [],
        coverage: [{ provider: 'claude_transcript', status: 'skipped' }],
        warnings: [],
        truncated: false,
        overflowCount: 0,
        generatedAt,
      },
    ],
  };
}

function batchResponse(memberNames: string[], generatedAt: string): MemberLogPreviewResponse {
  return {
    generatedAt,
    members: memberNames.map((memberName) => ({
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
    })),
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

const ReloadProbe = ({
  teamName,
  memberNames,
  onState,
  onReload,
}: {
  teamName: string;
  memberNames: string[];
  onState: (state: ReturnType<typeof useGraphMemberLogPreviews>) => void;
  onReload: (reload: ReturnType<typeof useGraphMemberLogPreviews>['reload']) => void;
}): React.JSX.Element | null => {
  const state = useGraphMemberLogPreviews({
    teamName,
    memberNames,
  });
  useEffect(() => {
    onState(state);
    onReload(state.reload);
  }, [onReload, onState, state]);
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
          laneIdsByMember={{
            alice: 'secondary:opencode:alice',
            bob: 'secondary:opencode:bob',
          }}
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
        forceRefresh: true,
        laneIdsByMember: { alice: 'secondary:opencode:alice' },
      })
    );

    act(() => {
      root.unmount();
    });
  });

  it('shows loading while the first visible preview request is still debounced', async () => {
    const firstLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews.mockReturnValueOnce(firstLoad.promise);

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

    expect(latestState()?.loading).toBe(true);
    expect(apiMock.memberLogStream.getMemberLogPreviews).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      firstLoad.resolve(response('alice', '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    act(() => {
      root.unmount();
    });
  });

  it('does not duplicate the initial debounced request in React StrictMode', async () => {
    apiMock.memberLogStream.getMemberLogPreviews.mockResolvedValue(
      response('alice', '2026-04-03T00:00:00.000Z')
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <React.StrictMode>
          <HookProbe teamName="alpha-team" memberNames={['alice']} onState={() => undefined} />
        </React.StrictMode>
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it('clears a scheduled preview request when unmounted before the debounce fires', async () => {
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
    act(() => {
      root.unmount();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).not.toHaveBeenCalled();
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

  it('does not show stale previews as loaded after switching teams with the same visible member', async () => {
    const betaLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockResolvedValueOnce(response('alice', '2026-04-03T00:00:00.000Z'))
      .mockReturnValueOnce(betaLoad.promise);

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
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.id).toBe(
      'alice:2026-04-03T00:00:00.000Z'
    );

    await act(async () => {
      root.render(<HookProbe teamName="beta-team" memberNames={['alice']} onState={onState} />);
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);
    expect(latestState()?.previewsByMember.get('alice')).toBeUndefined();
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'beta-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      betaLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.id).toBe(
      'alice:2026-04-03T00:01:00.000Z'
    );

    act(() => {
      root.unmount();
    });
  });

  it('does not duplicate preview requests when the same visible members are reordered', async () => {
    const firstLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews.mockReturnValueOnce(firstLoad.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" memberNames={['alice', 'bob']} onState={() => undefined} />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice', 'bob'],
      expect.any(Object)
    );

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" memberNames={['bob', 'alice']} onState={() => undefined} />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstLoad.resolve(batchResponse(['alice', 'bob'], '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" memberNames={['alice', 'bob']} onState={() => undefined} />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it('ignores stale responses when the same member receives a newer lane request', async () => {
    const oldLaneLoad = createDeferred<MemberLogPreviewResponse>();
    const newLaneLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockReturnValueOnce(oldLaneLoad.promise)
      .mockReturnValueOnce(newLaneLoad.promise);

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
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:old' }}
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:new' }}
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      newLaneLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.id).toBe(
      'alice:2026-04-03T00:01:00.000Z'
    );

    await act(async () => {
      oldLaneLoad.resolve(response('alice', '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.id).toBe(
      'alice:2026-04-03T00:01:00.000Z'
    );

    act(() => {
      root.unmount();
    });
  });

  it('does not reload when only a non-visible member lane changes', async () => {
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
          memberNames={['alice']}
          laneIdsByMember={{
            alice: 'secondary:opencode:alice',
            bob: 'secondary:opencode:bob:old',
          }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{
            alice: 'secondary:opencode:alice',
            bob: 'secondary:opencode:bob:new',
          }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it('falls back to normalized lane ids when an exact member key is blank', async () => {
    apiMock.memberLogStream.getMemberLogPreviews.mockResolvedValue(
      response('Alice', '2026-04-03T00:00:00.000Z')
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['Alice']}
          laneIdsByMember={{
            Alice: '   ',
            alice: 'secondary:opencode:alice',
          }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['Alice'],
      expect.objectContaining({
        laneIdsByMember: {
          Alice: 'secondary:opencode:alice',
          alice: 'secondary:opencode:alice',
        },
      })
    );

    act(() => {
      root.unmount();
    });
  });

  it('preserves a pending forced reload when lane metadata rerenders before debounce fires', async () => {
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
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:old' }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:new' }}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({
        forceRefresh: true,
        laneIdsByMember: { alice: 'secondary:opencode:alice:new' },
      })
    );

    act(() => {
      root.unmount();
    });
  });

  it('force refreshes visible previews after returning from a hidden document', async () => {
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

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
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

  it('marks empty cached previews as loading while a forced event refresh is pending', async () => {
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    const refreshLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogPreviews
      .mockResolvedValueOnce(emptyResponse('alice', '2026-04-03T00:00:00.000Z'))
      .mockReturnValueOnce(refreshLoad.promise);

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
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items).toHaveLength(0);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      await Promise.resolve();
    });

    expect(latestState()?.loading).toBe(true);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      refreshLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    act(() => {
      root.unmount();
    });
  });

  it('keeps loading when an empty visible response arrives before a pending forced refresh starts', async () => {
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    const initialLoad = createDeferred<MemberLogPreviewResponse>();
    const refreshLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogPreviews
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(refreshLoad.promise);

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
    expect(latestState()?.loading).toBe(true);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);

    await act(async () => {
      initialLoad.resolve(emptyResponse('alice', '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);
    expect(latestState()?.previewsByMember.get('alice')?.items).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    act(() => {
      root.unmount();
    });
  });

  it('marks empty cached previews as loading during a direct forced reload', async () => {
    const refreshLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockResolvedValueOnce(emptyResponse('alice', '2026-04-03T00:00:00.000Z'))
      .mockReturnValueOnce(refreshLoad.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const states: ReturnType<typeof useGraphMemberLogPreviews>[] = [];
    const onState = vi.fn((state: ReturnType<typeof useGraphMemberLogPreviews>) => {
      states.push(state);
    });
    const latestState = (): ReturnType<typeof useGraphMemberLogPreviews> | undefined =>
      states.at(-1);
    let reload: ReturnType<typeof useGraphMemberLogPreviews>['reload'] | null = null;

    await act(async () => {
      root.render(
        <ReloadProbe
          teamName="alpha-team"
          memberNames={['alice']}
          onState={onState}
          onReload={(nextReload) => {
            reload = nextReload;
          }}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items).toHaveLength(0);

    await act(async () => {
      void reload?.({ background: true, forceRefresh: true });
      await Promise.resolve();
    });

    expect(latestState()?.loading).toBe(true);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      refreshLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('keeps loading and ignores stale errors while a newer empty-preview refresh is in flight', async () => {
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    const staleRefresh = createDeferred<MemberLogPreviewResponse>();
    const latestRefresh = createDeferred<MemberLogPreviewResponse>();
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogPreviews
      .mockResolvedValueOnce(emptyResponse('alice', '2026-04-03T00:00:00.000Z'))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(latestRefresh.promise);

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
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:old' }}
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(1);
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items).toHaveLength(0);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);
    expect(latestState()?.loading).toBe(true);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          memberNames={['alice']}
          laneIdsByMember={{ alice: 'secondary:opencode:alice:new' }}
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(3);

    await act(async () => {
      staleRefresh.reject(new Error('stale lane failed'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);
    expect(latestState()?.error).toBeNull();
    expect(latestState()?.previewsByMember.get('alice')?.items).toHaveLength(0);

    await act(async () => {
      latestRefresh.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.error).toBeNull();
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.preview).toBe('alice');

    act(() => {
      root.unmount();
    });
  });

  it('ignores hidden member request loading and errors after the visible member changes', async () => {
    const hiddenAliceLoad = createDeferred<MemberLogPreviewResponse>();
    const visibleBobLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.memberLogStream.getMemberLogPreviews
      .mockReturnValueOnce(hiddenAliceLoad.promise)
      .mockReturnValueOnce(visibleBobLoad.promise);

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
    expect(latestState()?.loading).toBe(true);

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['bob']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      hiddenAliceLoad.reject(new Error('hidden alice failed before bob starts'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);
    expect(latestState()?.error).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      visibleBobLoad.resolve(emptyResponse('bob', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.error).toBeNull();
    expect(latestState()?.previewsByMember.get('bob')?.items).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it('ignores old same-key responses after switching away from and back to a team', async () => {
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    const oldAlphaLoad = createDeferred<MemberLogPreviewResponse>();
    const currentAlphaLoad = createDeferred<MemberLogPreviewResponse>();
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogPreviews
      .mockReturnValueOnce(oldAlphaLoad.promise)
      .mockReturnValueOnce(currentAlphaLoad.promise);

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
      root.render(<HookProbe teamName="beta-team" memberNames={[]} onState={onState} />);
      await Promise.resolve();
    });
    expect(latestState()?.previewsByMember.size).toBe(0);

    await act(async () => {
      root.render(<HookProbe teamName="alpha-team" memberNames={['alice']} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldAlphaLoad.resolve(response('alice', '2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(true);
    expect(latestState()?.previewsByMember.get('alice')).toBeUndefined();

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(2);

    await act(async () => {
      currentAlphaLoad.resolve(response('alice', '2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.loading).toBe(false);
    expect(latestState()?.previewsByMember.get('alice')?.items[0]?.id).toBe(
      'alice:2026-04-03T00:01:00.000Z'
    );

    act(() => {
      root.unmount();
    });
  });

  it('reloads visible members on log change events with force refresh', async () => {
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

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(3);
    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenLastCalledWith(
      'alpha-team',
      ['alice'],
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'task-log-change' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogPreviews).toHaveBeenCalledTimes(4);
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
