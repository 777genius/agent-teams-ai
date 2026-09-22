import { describe, expect, it, vi } from 'vitest';

import { GetMemberLogStreamUseCase } from '../GetMemberLogStreamUseCase';

import type { MemberLogStreamSegment } from '../../../../contracts';
import type {
  MemberLogStreamSource,
  MemberLogStreamSourceResult,
} from '../../ports/MemberLogStreamSource';
import type { BoardTaskLogParticipant } from '@shared/types';

const generatedAt = Date.parse('2026-02-01T00:00:00.000Z');

const participant: BoardTaskLogParticipant = {
  key: 'member:alice',
  label: 'alice',
  role: 'member',
  isLead: false,
  isSidechain: false,
};

function segment(id: string): MemberLogStreamSegment {
  return {
    id,
    participantKey: participant.key,
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: `session-${id}`,
      isSidechain: false,
    },
    startTimestamp: '2026-02-01T00:00:00.000Z',
    endTimestamp: '2026-02-01T00:00:00.000Z',
    chunks: [],
    source: {
      provider: 'claude_transcript',
      label: 'Claude transcript',
      sessionId: `session-${id}`,
    },
  };
}

function includedResult(id: string): MemberLogStreamSourceResult {
  return {
    provider: 'claude_transcript',
    status: 'included',
    participants: [participant],
    segments: [segment(id)],
    warnings: [],
    metadata: {
      scannedTranscriptFileCount: 1,
      includedTranscriptFileCount: 1,
    },
  };
}

describe('GetMemberLogStreamUseCase', () => {
  it('keeps the stream fail-soft when one source throws', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const useCase = new GetMemberLogStreamUseCase({
      sources: [
        {
          provider: 'claude_transcript',
          load: vi.fn().mockResolvedValue(includedResult('ok')),
        },
        {
          provider: 'opencode_runtime',
          load: vi.fn().mockRejectedValue(new Error('runtime down')),
        },
      ],
      clock: { now: () => generatedAt },
      logger,
    });

    const response = await useCase.execute({
      teamName: 'alpha-team',
      memberName: 'alice',
    });

    expect(response.segments.map((item) => item.id)).toEqual(['ok']);
    expect(response.coverage).toEqual([
      { provider: 'claude_transcript', status: 'included' },
      { provider: 'opencode_runtime', status: 'skipped', reason: 'runtime down' },
    ]);
    expect(response.warnings).toEqual([
      { code: 'opencode_runtime_unavailable', message: 'runtime down' },
    ]);
    expect(response.generatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(logger.warn).toHaveBeenCalledWith(
      'Member log stream source opencode_runtime failed for alpha-team/alice: runtime down'
    );
  });

  it('joins identical in-flight requests and releases the key after completion', async () => {
    const resolveLoad: ((value: MemberLogStreamSourceResult) => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise<MemberLogStreamSourceResult>((resolve) => {
          resolveLoad.push(resolve);
        })
    );
    const source: MemberLogStreamSource = {
      provider: 'claude_transcript',
      load,
    };
    const useCase = new GetMemberLogStreamUseCase({
      sources: [source],
      clock: { now: () => generatedAt },
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const first = useCase.execute({
      teamName: 'alpha-team',
      memberName: 'alice',
      limitSegments: 5,
      forceRefresh: true,
    });
    const second = useCase.execute({
      teamName: 'alpha-team',
      memberName: 'alice',
      limitSegments: 5,
      forceRefresh: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad[0]?.(includedResult('joined'));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.segments.map((item) => item.id)).toEqual(['joined']);
    expect(secondResponse.segments.map((item) => item.id)).toEqual(['joined']);

    const third = useCase.execute({
      teamName: 'alpha-team',
      memberName: 'alice',
      limitSegments: 5,
      forceRefresh: true,
    });

    expect(load).toHaveBeenCalledTimes(2);
    resolveLoad[1]?.(includedResult('after-release'));
    await expect(third).resolves.toMatchObject({
      segments: [{ id: 'after-release' } as MemberLogStreamSegment],
    });
  });
});
