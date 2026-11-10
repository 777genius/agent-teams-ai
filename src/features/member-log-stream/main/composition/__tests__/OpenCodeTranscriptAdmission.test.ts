import { afterEach, expect, it, vi } from 'vitest';

import { createMemberLogStreamFeature } from '../createMemberLogStreamFeature';

const state = vi.hoisted(() => ({
  stamp: 'original',
  release: undefined as (() => void) | undefined,
  loads: 0,
  nativeItems: 1,
  nativeOverflow: 0,
  nativeTime: '2026-10-29T00:00:00.000Z',
  claudeItems: 0,
  claudeOverflow: 0,
  retainedStream: false,
}));
vi.mock(
  '../../adapters/output/sources/OpenCodeMemberTranscriptBindingReader',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../adapters/output/sources/OpenCodeMemberTranscriptBindingReader')
      >();
    return {
      ...actual,
      OpenCodeMemberTranscriptBindingReader: class {
        async read(input: { memberName: string }) {
          return {
            kind: 'bound',
            mode: 'active',
            runId: state.stamp,
            laneId: 'primary',
            sessionId: `ses_${input.memberName}`,
            cacheKey: `${input.memberName}:${state.stamp}`,
          };
        }
        async isCurrent(input: { memberName: string }, binding: { cacheKey: string }) {
          return binding.cacheKey === `${input.memberName}:${state.stamp}`;
        }
      },
    };
  }
);
vi.mock('../../adapters/output/sources/OpenCodeMemberRuntimePreviewSource', () => ({
  OpenCodeMemberRuntimePreviewSource: class {
    async loadPreview(input: { memberName: string }) {
      state.loads++;
      return {
        provider: 'opencode_runtime',
        status: 'included',
        warnings: [],
        truncated: state.nativeOverflow > 0,
        overflowCount: state.nativeOverflow,
        items: Array.from({ length: state.nativeItems }, (_, index) => ({
          id: `${input.memberName}:native:${index}`,
          provider: 'opencode_runtime',
          kind: 'text',
          tone: 'neutral',
          timestamp: state.nativeTime,
          title: 'Native',
          sourceLabel: 'OpenCode runtime',
          sessionId: `ses_${input.memberName}`,
        })),
      };
    }
  },
}));
vi.mock('../../adapters/output/sources/ClaudeMemberTranscriptPreviewSource', () => ({
  ClaudeMemberTranscriptPreviewSource: class {
    async loadPreview() {
      if (!state.release)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      return {
        provider: 'claude_transcript',
        status: state.claudeItems > 0 ? 'included' : 'skipped',
        items: Array.from({ length: state.claudeItems }, (_, index) => ({
          id: `retained:${index}`,
          provider: 'claude_transcript',
          kind: 'text',
          tone: 'neutral',
          timestamp: '2026-10-29T00:01:00.000Z',
          title: 'Retained',
          sourceLabel: 'Claude transcript',
        })),
        warnings: [],
        truncated: state.claudeOverflow > 0,
        overflowCount: state.claudeOverflow,
      };
    }
  },
}));
vi.mock('../../adapters/output/sources/CodexNativeMemberTracePreviewSource', () => ({
  CodexNativeMemberTracePreviewSource: class {
    async loadPreview() {
      return {
        provider: 'codex_native_trace',
        status: 'skipped',
        items: [],
        warnings: [],
        truncated: false,
        overflowCount: 0,
      };
    }
  },
}));
vi.mock('../../adapters/output/sources/OpenCodeMemberRuntimeStreamSource', () => ({
  OpenCodeMemberRuntimeStreamSource: class {
    async load() {
      return {
        provider: 'opencode_runtime',
        status: 'included',
        warnings: [],
        participants: [
          { key: 'native-only', label: 'Native', role: 'member', isLead: false, isSidechain: true },
        ],
        segments: [
          {
            id: 'native',
            participantKey: 'native-only',
            chunks: [],
            startTimestamp: '2026-10-29T00:00:00.000Z',
            endTimestamp: '2026-10-29T00:00:00.000Z',
            source: { provider: 'opencode_runtime', label: 'OpenCode runtime' },
          },
        ],
      };
    }
  },
}));
vi.mock('../../adapters/output/sources/ClaudeMemberTranscriptStreamSource', () => ({
  ClaudeMemberTranscriptStreamSource: class {
    async load() {
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      return {
        provider: 'claude_transcript',
        status: state.retainedStream ? 'included' : 'skipped',
        warnings: [],
        participants: state.retainedStream
          ? [
              {
                key: 'retained',
                label: 'Retained',
                role: 'member',
                isLead: false,
                isSidechain: true,
              },
            ]
          : [],
        segments: state.retainedStream
          ? [
              {
                id: 'retained',
                participantKey: 'retained',
                chunks: [],
                startTimestamp: '2026-10-29T00:00:00.000Z',
                endTimestamp: '2026-10-29T00:00:00.000Z',
                source: { provider: 'claude_transcript', label: 'Claude transcript' },
              },
            ]
          : [],
      };
    }
  },
}));
vi.mock('../../adapters/output/sources/CodexNativeMemberTraceStreamSource', () => ({
  CodexNativeMemberTraceStreamSource: class {
    async load() {
      return {
        provider: 'codex_native_trace',
        status: 'skipped',
        warnings: [],
        participants: [],
        segments: [],
      };
    }
  },
}));
afterEach(() => {
  state.stamp = 'original';
  state.release = undefined;
  state.loads = 0;
  state.nativeItems = 1;
  state.nativeOverflow = 0;
  state.nativeTime = '2026-10-29T00:00:00.000Z';
  state.claudeItems = 0;
  state.claudeOverflow = 0;
  state.retainedStream = false;
});

it('fences duplicate-prefixed preview members and does not let a successor join the old aggregate', async () => {
  state.nativeOverflow = 5;
  const feature = createMemberLogStreamFeature({
    logsFinder: {} as never,
    logSourceTracker: {} as never,
    runtimeBridge: {} as never,
    configReader: {} as never,
    runtimeLogTailReader: {} as never,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const request = {
    teamName: 'TEST-team',
    memberNames: [...Array<string>(40).fill('alice'), 'bob'],
    laneIdsByMember: { alice: 'primary', bob: 'primary' },
  };
  const original = feature.getMemberLogPreviews(request);
  await vi.waitFor(() => expect(state.release).toBeTypeOf('function'));
  state.stamp = 'successor';
  const successor = feature.getMemberLogPreviews(request);
  state.release!();
  const [stale, fresh] = await Promise.all([original, successor]);
  expect(stale.members.map((member) => member.memberName)).toEqual(['alice', 'bob']);
  expect(stale.members.every((member) => member.items.length === 0)).toBe(true);
  expect(
    stale.members.every((member) =>
      member.warnings.some((warning) => warning.code === 'opencode_runtime_unavailable')
    )
  ).toBe(true);
  expect(fresh.members.every((member) => member.items.length === 1)).toBe(true);
  expect(stale.members.every((member) => member.overflowCount === 0 && !member.truncated)).toBe(
    true
  );
  expect(state.loads).toBe(4);
});

it.each(['2026-10-29T00:00:00.000Z', '2026-10-29T00:02:00.000Z'])(
  'reprojects eligible preview items and independent limits after a stale native source (%s)',
  async (nativeTime) => {
    state.nativeTime = nativeTime;
    state.nativeItems = 3;
    state.nativeOverflow = 7;
    state.claudeItems = 3;
    state.claudeOverflow = 4;
    const feature = createMemberLogStreamFeature({
      logsFinder: {} as never,
      logSourceTracker: {} as never,
      runtimeBridge: {} as never,
      configReader: {} as never,
      runtimeLogTailReader: {} as never,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const pending = feature.getMemberLogPreviews({
      teamName: 'TEST-team',
      memberNames: ['alice'],
      laneIdsByMember: { alice: 'primary' },
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf('function'));
    state.stamp = 'successor';
    state.release!();
    const result = (await pending).members[0];
    expect(result.items.map((item) => item.id)).toEqual(['retained:0', 'retained:1', 'retained:2']);
    expect(result).toMatchObject({ overflowCount: 4, truncated: true });
    expect(result.coverage).toContainEqual({
      provider: 'opencode_runtime',
      status: 'skipped',
      reason: 'opencode_runtime_unavailable',
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'opencode_runtime_unavailable' })
    );
  }
);

it.each([false, true])(
  'drops native-only participant chips after the final stream fence (retained=%s)',
  async (retained) => {
    state.retainedStream = retained;
    const feature = createMemberLogStreamFeature({
      logsFinder: {} as never,
      logSourceTracker: {} as never,
      runtimeBridge: {} as never,
      configReader: {} as never,
      runtimeLogTailReader: {} as never,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const pending = feature.getMemberLogStream({
      teamName: 'TEST-team',
      memberName: 'alice',
      laneId: 'primary',
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf('function'));
    state.stamp = 'successor';
    state.release!();
    const result = await pending;
    expect(result.segments.map((segment) => segment.id)).toEqual(retained ? ['retained'] : []);
    expect(result.participants.map((participant) => participant.key)).toEqual(
      retained ? ['retained'] : []
    );
    expect(result.defaultFilter).toBe(retained ? 'retained' : 'all');
  }
);
