import { createStreamingParser } from '@openuidev/lang-core';

import { chatVisualizationLibrary } from './chatVisualizationLibrary';

export function createChatVisualizationParser(): ReturnType<typeof createStreamingParser> {
  return createStreamingParser(
    chatVisualizationLibrary.toJSONSchema(),
    chatVisualizationLibrary.root
  );
}

export function parseChatVisualization(
  source: string
): ReturnType<ReturnType<typeof createStreamingParser>['set']> {
  return createChatVisualizationParser().set(source);
}
