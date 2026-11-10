import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMemberLogStream } from '../useMemberLogStream';

import type { MemberLogStreamResponse } from '../../../contracts';
import type { ResolvedTeamMember } from '@shared/types';

const apiMock = vi.hoisted(() => ({
  memberLogStream: {
    getMemberLogStream: vi.fn(),
    setMemberLogStreamTracking: vi.fn(),
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

function member(name: string): ResolvedTeamMember {
  return {
    name,
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
  };
}

function response(generatedAt: string): MemberLogStreamResponse {
  return {
    participants: [],
    defaultFilter: 'all',
    segments: [],
    source: 'member_empty',
    coverage: [],
    warnings: [],
    truncated: false,
    generatedAt,
    metadata: {
      scannedTranscriptFileCount: 0,
      includedTranscriptFileCount: 0,
      droppedSegmentCount: 0,
      droppedChunkCount: 0,
      droppedMessageCount: 0,
    },
  };
}

const HookProbe = ({
  teamName,
  selectedMember,
  enabled = true,
  onState,
}: {
  teamName: string;
  selectedMember: ResolvedTeamMember;
  enabled?: boolean;
  onState: (state: ReturnType<typeof useMemberLogStream>) => void;
}): React.JSX.Element | null => {
  const state = useMemberLogStream({ teamName, member: selectedMember, enabled });
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
};

describe('useMemberLogStream', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMock.memberLogStream.getMemberLogStream.mockReset();
    apiMock.memberLogStream.setMemberLogStreamTracking.mockReset();
    apiMock.memberLogStream.setMemberLogStreamTracking.mockResolvedValue(undefined);
    apiMock.teams.onTeamChange.mockReset();
    apiMock.teams.onTeamChange.mockReturnValue(() => undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not let an older in-flight member request drive a pending reload after member key changes', async () => {
    const aliceLoad = createDeferred<MemberLogStreamResponse>();
    const bobLoad = createDeferred<MemberLogStreamResponse>();
    apiMock.memberLogStream.getMemberLogStream
      .mockReturnValueOnce(aliceLoad.promise)
      .mockReturnValueOnce(bobLoad.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onState = vi.fn((_: ReturnType<typeof useMemberLogStream>) => undefined);
    const latestState = (): ReturnType<typeof useMemberLogStream> | undefined =>
      onState.mock.calls.at(-1)?.[0];

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" selectedMember={member('alice')} onState={onState} />
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        <HookProbe teamName="alpha-team" selectedMember={member('bob')} onState={onState} />
      );
      await Promise.resolve();
    });

    const requestedMembers = apiMock.memberLogStream.getMemberLogStream.mock.calls.map(
      (call: unknown[]) => String(call[1])
    );
    expect(requestedMembers).toEqual(['alice', 'bob']);

    await act(async () => {
      aliceLoad.resolve(response('2026-04-03T00:00:00.000Z'));
      await Promise.resolve();
    });

    expect(latestState()?.stream).toBeNull();

    await act(async () => {
      bobLoad.resolve(response('2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });

    expect(latestState()?.stream?.generatedAt).toBe('2026-04-03T00:01:00.000Z');

    act(() => {
      root.unmount();
    });
  });

  it('reloads on same-team log events with forceRefresh only for source changes', async () => {
    vi.useFakeTimers();
    let teamChangeListener:
      | ((event: unknown, data: { teamName: string; type: string }) => void)
      | null = null;
    apiMock.teams.onTeamChange.mockImplementation((callback) => {
      teamChangeListener = callback as typeof teamChangeListener;
      return () => undefined;
    });
    apiMock.memberLogStream.getMemberLogStream
      .mockResolvedValueOnce(response('2026-04-03T00:00:00.000Z'))
      .mockResolvedValueOnce(response('2026-04-03T00:01:00.000Z'))
      .mockResolvedValueOnce(response('2026-04-03T00:02:00.000Z'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          selectedMember={member('alice')}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'other-team', type: 'log-source-change' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'tool-activity' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'log-source-change' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(2);
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenLastCalledWith(
      'alpha-team',
      'alice',
      expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      teamChangeListener?.(null, { teamName: 'alpha-team', type: 'task-log-change' });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(3);
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenLastCalledWith(
      'alpha-team',
      'alice',
      expect.not.objectContaining({ forceRefresh: true })
    );

    act(() => {
      root.unmount();
    });
  });

  it('releases stale in-flight state when the section is disabled before a request finishes', async () => {
    const firstLoad = createDeferred<MemberLogStreamResponse>();
    apiMock.memberLogStream.getMemberLogStream
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(response('2026-04-03T00:02:00.000Z'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onState = vi.fn((_: ReturnType<typeof useMemberLogStream>) => undefined);
    const latestState = (): ReturnType<typeof useMemberLogStream> | undefined =>
      onState.mock.calls.at(-1)?.[0];
    const selectedMember = member('alice');

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          selectedMember={selectedMember}
          enabled
          onState={onState}
        />
      );
      await Promise.resolve();
    });
    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          selectedMember={selectedMember}
          enabled={false}
          onState={onState}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      firstLoad.resolve(response('2026-04-03T00:01:00.000Z'));
      await Promise.resolve();
    });
    expect(latestState()?.stream).toBeNull();

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          selectedMember={selectedMember}
          enabled
          onState={onState}
        />
      );
      await Promise.resolve();
    });

    expect(apiMock.memberLogStream.getMemberLogStream).toHaveBeenCalledTimes(2);
    expect(latestState()?.stream?.generatedAt).toBe('2026-04-03T00:02:00.000Z');

    act(() => {
      root.unmount();
    });
  });

  it('passes an OpenCode lane only for OpenCode-owned members', async () => {
    apiMock.memberLogStream.getMemberLogStream.mockResolvedValue(
      response('2026-04-03T00:00:00.000Z')
    );
    const staleLaneMember: ResolvedTeamMember = {
      ...member('alice'),
      providerId: 'anthropic',
      laneId: 'secondary:opencode:alice',
      laneOwnerProviderId: 'opencode',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          teamName="alpha-team"
          selectedMember={staleLaneMember}
          onState={() => undefined}
        />
      );
      await Promise.resolve();
    });

    const request = apiMock.memberLogStream.getMemberLogStream.mock.calls[0] as
      | [string, string, { laneId?: unknown }]
      | undefined;
    expect(request?.[0]).toBe('alpha-team');
    expect(request?.[1]).toBe('alice');
    expect(request?.[2].laneId).toBeUndefined();

    act(() => {
      root.unmount();
    });
  });
});
