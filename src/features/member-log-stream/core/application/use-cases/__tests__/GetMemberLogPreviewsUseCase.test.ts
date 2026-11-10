import { describe, expect, it, vi } from 'vitest';

import { GetMemberLogPreviewsUseCase } from '../GetMemberLogPreviewsUseCase';

import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceInput,
  MemberLogPreviewSourceResult,
} from '../../ports/MemberLogPreviewSource';

function source(
  provider: MemberLogPreviewSource['provider'],
  loadPreview: (
    input: MemberLogPreviewSourceInput
  ) => ReturnType<MemberLogPreviewSource['loadPreview']>
): MemberLogPreviewSource {
  return { provider, loadPreview };
}

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

function textResult(memberName: string): MemberLogPreviewSourceResult {
  return {
    provider: 'claude_transcript',
    status: 'included',
    items: [
      {
        id: `item:${memberName}`,
        kind: 'text',
        provider: 'claude_transcript',
        timestamp: '2026-04-01T12:00:00.000Z',
        title: 'Assistant',
        preview: memberName,
        tone: 'neutral',
      },
    ],
    warnings: [],
    truncated: false,
    overflowCount: 0,
  };
}

describe('GetMemberLogPreviewsUseCase', () => {
  it('dedupes members, clamps options, and merges source coverage per member', async () => {
    const loadPreview = vi.fn(async (input: MemberLogPreviewSourceInput) => ({
      provider: 'claude_transcript' as const,
      status: 'included' as const,
      items: [
        {
          id: `item:${input.memberName}`,
          kind: 'text' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-01T12:00:00.000Z',
          title: 'Assistant',
          preview: input.memberName,
          tone: 'neutral' as const,
        },
      ],
      warnings: [],
      truncated: false,
      overflowCount: 0,
    }));
    const useCase = new GetMemberLogPreviewsUseCase({
      sources: [source('claude_transcript', loadPreview)],
      clock: { now: () => Date.parse('2026-04-01T12:01:00.000Z') },
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    const response = await useCase.execute({
      teamName: 'alpha-team',
      memberNames: ['alice', 'Alice', 'bob'],
      maxItemsPerMember: 99,
      textLimit: 999,
      laneIdsByMember: { alice: 'secondary:opencode:alice' },
    });

    expect(response.members.map((member) => member.memberName)).toEqual(['alice', 'bob']);
    expect(loadPreview).toHaveBeenCalledTimes(2);
    expect(loadPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: 'alice',
        maxItems: 3,
        textLimit: 200,
        laneId: 'secondary:opencode:alice',
      })
    );
    expect(response.members[0]?.coverage).toEqual([
      { provider: 'claude_transcript', status: 'included' },
    ]);
  });

  it('dedupes in-flight identical batch requests', async () => {
    const loadPreview = vi.fn(async (_input: MemberLogPreviewSourceInput) => ({
      provider: 'codex_native_trace' as const,
      status: 'skipped' as const,
      reason: 'codex_member_wide_not_supported',
      items: [],
      warnings: [
        {
          code: 'codex_member_wide_not_supported' as const,
          message: 'Codex member-wide native trace is not available in this variant yet.',
        },
      ],
      truncated: false,
      overflowCount: 0,
    }));
    const useCase = new GetMemberLogPreviewsUseCase({
      sources: [source('codex_native_trace', loadPreview)],
      clock: { now: () => Date.parse('2026-04-01T12:01:00.000Z') },
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    const [first, second] = await Promise.all([
      useCase.execute({ teamName: 'alpha-team', memberNames: ['codex'] }),
      useCase.execute({ teamName: 'alpha-team', memberNames: ['codex'] }),
    ]);

    expect(first).toEqual(second);
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(first.members[0]?.warnings[0]?.code).toBe('codex_member_wide_not_supported');
  });

  it('dedupes in-flight batch requests for the same member set in different order', async () => {
    const pendingByMember = new Map<
      string,
      ReturnType<typeof createDeferred<MemberLogPreviewSourceResult>>
    >();
    const loadPreview = vi.fn((input: MemberLogPreviewSourceInput) => {
      const deferred = createDeferred<MemberLogPreviewSourceResult>();
      pendingByMember.set(input.memberName, deferred);
      return deferred.promise;
    });
    const useCase = new GetMemberLogPreviewsUseCase({
      sources: [source('claude_transcript', loadPreview)],
      clock: { now: () => Date.parse('2026-04-01T12:01:00.000Z') },
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    const firstPromise = useCase.execute({
      teamName: 'alpha-team',
      memberNames: ['alice', 'bob'],
    });
    const secondPromise = useCase.execute({
      teamName: 'alpha-team',
      memberNames: ['bob', 'alice'],
    });

    expect(loadPreview).toHaveBeenCalledTimes(2);
    pendingByMember.get('alice')?.resolve(textResult('alice'));
    pendingByMember.get('bob')?.resolve(textResult('bob'));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(second).toBe(first);
    expect(first.members.map((member) => member.memberName)).toEqual(['alice', 'bob']);
  });
});
