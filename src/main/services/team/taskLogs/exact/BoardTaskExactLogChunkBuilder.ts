import { ChunkBuilder } from '@main/services/analysis/ChunkBuilder';

import type { EnhancedChunk, ParsedMessage } from '@main/types';

export class BoardTaskExactLogChunkBuilder {
  constructor(private readonly chunkBuilder: ChunkBuilder = new ChunkBuilder()) {}

  buildBundleChunks(messages: ParsedMessage[]): EnhancedChunk[] {
    return this.chunkBuilder.buildChunks(messages, [], { includeSidechain: true });
  }
}
