import { describe, expect, it, vi } from 'vitest';

import { BoardTaskExactLogChunkBuilder } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';

import type { EnhancedChunk, ParsedMessage } from '../../../../src/main/types';

describe('BoardTaskExactLogChunkBuilder', () => {
  it('delegates to ChunkBuilder with includeSidechain enabled', () => {
    const buildChunks = vi.fn<() => EnhancedChunk[]>(() => []);
    const messages = [{ uuid: 'm1' }] as unknown as ParsedMessage[];

    const builder = new BoardTaskExactLogChunkBuilder({ buildChunks } as never);
    const result = builder.buildBundleChunks(messages);

    expect(result).toEqual([]);
    expect(buildChunks).toHaveBeenCalledWith(messages, [], { includeSidechain: true });
  });

  it('does not crash on a minimal assistant-only bundle', () => {
    const messages: ParsedMessage[] = [
      {
        uuid: 'assistant-1',
        parentUuid: null,
        type: 'assistant',
        timestamp: new Date('2026-04-12T18:00:00.000Z'),
        role: 'assistant',
        content: [{ type: 'text', text: 'done' } as never],
        toolCalls: [],
        toolResults: [],
        isSidechain: true,
        isMeta: false,
        isCompactSummary: false,
      },
    ];

    const chunks = new BoardTaskExactLogChunkBuilder().buildBundleChunks(messages);

    expect(chunks.length).toBeGreaterThan(0);
  });
});
