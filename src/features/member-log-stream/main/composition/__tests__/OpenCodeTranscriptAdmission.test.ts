import { afterEach, expect, it, vi } from 'vitest';

import { createMemberLogStreamFeature } from '../createMemberLogStreamFeature';

const state = vi.hoisted(() => ({
  stamp: 'original',
  release: undefined as (() => void) | undefined,
  loads: 0,
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
        truncated: false,
        overflowCount: 0,
        items: [
          {
            id: input.memberName,
            provider: 'opencode_runtime',
            kind: 'text',
            tone: 'neutral',
            timestamp: '2026-10-29T00:00:00.000Z',
            title: 'Native',
            sourceLabel: 'OpenCode runtime',
            sessionId: `ses_${input.memberName}`,
          },
        ],
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
        status: 'skipped',
        items: [],
        warnings: [],
        truncated: false,
        overflowCount: 0,
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
afterEach(() => {
  state.stamp = 'original';
  state.release = undefined;
  state.loads = 0;
});

it('fences duplicate-prefixed preview members and does not let a successor join the old aggregate', async () => {
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
  expect(state.loads).toBe(4);
});
