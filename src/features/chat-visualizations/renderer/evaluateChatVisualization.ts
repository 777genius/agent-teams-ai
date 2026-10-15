import { guardChatVisualizationProgram } from './programGuards';

import type { FenceState } from '../contracts';
import type { createChatVisualizationParser } from './parseChatVisualization';

export type VisualizationStatus = 'content' | 'incomplete' | 'unavailable' | 'limit';
export interface VisualizationEvaluation {
  status: VisualizationStatus;
  canRender: boolean;
}

export function evaluateChatVisualization(
  parser: ReturnType<typeof createChatVisualizationParser>,
  source: string,
  state: FenceState
): VisualizationEvaluation {
  if (source.length > 32_000) return { status: 'limit', canRender: false };
  try {
    const parsed = parser.set(source);
    const checked = guardChatVisualizationProgram(parsed, state);
    if (checked.status === 'rejected') {
      return {
        status: checked.message.includes('display limits') ? 'limit' : 'unavailable',
        canRender: false,
      };
    }
    return {
      status: checked.status === 'ready' ? 'content' : 'incomplete',
      canRender: parsed.root !== null,
    };
  } catch {
    return { status: 'unavailable', canRender: false };
  }
}
