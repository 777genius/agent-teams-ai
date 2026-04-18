import { describe, expect, it } from 'vitest';

import { stripSessionDetailMessages } from '../../../../src/main/services/analysis/sessionDetailPayload';
import type { ParsedMessage, SessionDetail } from '../../../../src/main/types';

function createDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session: {
      id: 'session-1',
      projectId: 'project-1',
      projectPath: '/tmp/project',
      isOngoing: false,
      hasSubagents: false,
      messageCount: 0,
      createdAt: 0,
    },
    messages: [],
    chunks: [],
    processes: [],
    metrics: {
      durationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 0,
    },
    ...overrides,
  };
}

describe('stripSessionDetailMessages', () => {
  it('returns the same reference when messages is already empty', () => {
    const detail = createDetail();
    const result = stripSessionDetailMessages(detail);
    expect(result).toBe(detail);
  });

  it('drops the messages array when it is non-empty', () => {
    const messages = [{ uuid: 'm-1' } as unknown as ParsedMessage];
    const detail = createDetail({ messages });
    const result = stripSessionDetailMessages(detail);
    expect(result).not.toBe(detail);
    expect(result.messages).toEqual([]);
  });

  it('preserves every other field (session, chunks, processes, metrics)', () => {
    const messages = Array.from(
      { length: 3 },
      (_, i) => ({ uuid: `m-${i}` }) as unknown as ParsedMessage
    );
    const detail = createDetail({ messages });
    const result = stripSessionDetailMessages(detail);
    expect(result.session).toBe(detail.session);
    expect(result.chunks).toBe(detail.chunks);
    expect(result.processes).toBe(detail.processes);
    expect(result.metrics).toBe(detail.metrics);
  });

  it('does not mutate the input detail', () => {
    const messages = [{ uuid: 'm-1' } as unknown as ParsedMessage];
    const detail = createDetail({ messages });
    stripSessionDetailMessages(detail);
    expect(detail.messages).toBe(messages);
    expect(detail.messages).toHaveLength(1);
  });
});
