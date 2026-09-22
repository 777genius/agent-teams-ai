import { extractToolCalls, extractToolResults } from '@main/utils/toolExtraction';

import type { CodexNativeTraceEvent, CodexNativeTraceRun } from './CodexNativeTraceReader';
import type { ContentBlock, ParsedMessage, ToolUseResultData } from '@main/types';

export function buildCodexNativeToolSignature(args: {
  toolName?: string;
  input?: Record<string, unknown>;
}): string | null {
  const toolName = args.toolName?.trim();
  if (!toolName || toolName.startsWith('mcp__')) {
    return null;
  }
  const input = args.input ?? {};
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    return command ? `${toolName}:${command}` : null;
  }
  if (toolName === 'Edit') {
    const filePath =
      typeof input.file_path === 'string' && input.file_path.trim().length > 0
        ? input.file_path.trim()
        : Array.isArray(input.changes)
          ? input.changes
              .map((change) =>
                change && typeof change === 'object' && 'path' in change
                  ? String((change as Record<string, unknown>).path ?? '').trim()
                  : ''
              )
              .filter(Boolean)
              .join(',')
          : '';
    return filePath ? `${toolName}:${filePath}` : null;
  }
  return `${toolName}:${JSON.stringify(input)}`;
}

function resultContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') {
      return record.content;
    }
    if (typeof record.stderr === 'string' && record.stderr.trim().length > 0) {
      return record.stderr;
    }
    if (typeof record.message === 'string') {
      return record.message;
    }
  }
  return result == null ? '' : JSON.stringify(result);
}

function asToolUseResult(
  result: unknown,
  fallback: {
    toolName: string;
    toolUseId: string;
    isError: boolean;
  }
): ToolUseResultData {
  const content = resultContent(result);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return {
      ...(result as Record<string, unknown>),
      content,
      toolName: fallback.toolName,
      toolUseId: fallback.toolUseId,
      isError: fallback.isError,
    };
  }
  return {
    content,
    toolName: fallback.toolName,
    toolUseId: fallback.toolUseId,
    isError: fallback.isError,
  };
}

function baseMessage(params: {
  uuid: string;
  type: 'assistant' | 'user';
  timestamp: Date;
  content: ContentBlock[];
  role?: 'assistant' | 'user';
  cwd?: string;
  sessionId: string;
  agentName?: string;
  isMeta?: boolean;
}): ParsedMessage {
  const message: ParsedMessage = {
    uuid: params.uuid,
    parentUuid: null,
    type: params.type,
    timestamp: params.timestamp,
    content: params.content,
    sessionId: params.sessionId,
    isSidechain: false,
    isMeta: params.isMeta ?? false,
    toolCalls: extractToolCalls(params.content),
    toolResults: extractToolResults(params.content),
  };

  if (params.role) {
    message.role = params.role;
  }

  if (params.type === 'assistant') {
    message.model = '<synthetic>';
  }

  if (params.cwd) {
    message.cwd = params.cwd;
  }

  if (params.agentName) {
    message.agentName = params.agentName;
  }

  return message;
}

function buildSyntheticToolUseId(run: CodexNativeTraceRun, itemId: string): string {
  return `codex-trace:${run.teamName ?? 'unknown'}:${run.taskId ?? 'unknown'}:${run.runId}:${itemId}`;
}

function buildToolStartMessage(
  run: CodexNativeTraceRun,
  event: CodexNativeTraceEvent
): ParsedMessage | null {
  const projection = event.projection;
  if (!projection?.itemId || !projection.toolName) {
    return null;
  }
  const toolUseId = buildSyntheticToolUseId(run, projection.itemId);
  const content: ContentBlock[] = [
    {
      type: 'tool_use',
      id: toolUseId,
      name: projection.toolName,
      input: projection.input ?? {},
    },
  ];
  return baseMessage({
    uuid: `${toolUseId}:start`,
    timestamp: new Date(event.receivedAt),
    type: 'assistant',
    role: 'assistant',
    content,
    sessionId: run.runId,
    ...(run.cwd ? { cwd: run.cwd } : {}),
    ...(run.ownerName ? { agentName: run.ownerName } : {}),
  });
}

function buildToolResultMessage(
  run: CodexNativeTraceRun,
  event: CodexNativeTraceEvent
): ParsedMessage | null {
  const projection = event.projection;
  if (!projection?.itemId || !projection.toolName) {
    return null;
  }
  const toolUseId = buildSyntheticToolUseId(run, projection.itemId);
  const contentText = resultContent(projection.result);
  const isError = projection.isError === true;
  const content: ContentBlock[] = [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: contentText,
      ...(isError ? { is_error: true } : {}),
    },
  ];
  const toolUseResult = asToolUseResult(projection.result, {
    toolName: projection.toolName,
    toolUseId,
    isError,
  });
  return {
    ...baseMessage({
      uuid: `${toolUseId}:result`,
      timestamp: new Date(event.receivedAt),
      type: 'user',
      role: 'user',
      content,
      sessionId: run.runId,
      isMeta: true,
      ...(run.cwd ? { cwd: run.cwd } : {}),
      ...(run.ownerName ? { agentName: run.ownerName } : {}),
    }),
    sourceToolUseID: toolUseId,
    toolUseResult,
  };
}

export class CodexNativeTraceProjector {
  project(
    runs: CodexNativeTraceRun[],
    options: { excludeSignatures?: ReadonlySet<string> } = {}
  ): ParsedMessage[] {
    const messages: ParsedMessage[] = [];
    for (const run of runs) {
      const items = new Map<
        string,
        {
          firstOrder: number;
          start?: CodexNativeTraceEvent;
          result?: CodexNativeTraceEvent;
        }
      >();
      for (const event of run.events) {
        const projection = event.projection;
        if (projection?.toolSource !== 'native') {
          continue;
        }
        if (!projection.itemId) {
          continue;
        }
        const current = items.get(projection.itemId) ?? { firstOrder: event.sourceOrder };
        current.firstOrder = Math.min(current.firstOrder, event.sourceOrder);
        if (projection.kind === 'tool_start') {
          current.start = event;
        } else if (projection.kind === 'tool_result') {
          current.result = event;
        }
        items.set(projection.itemId, current);
      }

      for (const item of [...items.values()].sort(
        (left, right) => left.firstOrder - right.firstOrder
      )) {
        const projection = item.result?.projection ?? item.start?.projection;
        const signature = buildCodexNativeToolSignature({
          toolName: projection?.toolName,
          input: projection?.input,
        });
        if (signature && options.excludeSignatures?.has(signature)) {
          continue;
        }
        const start =
          item.start ??
          (item.result
            ? {
                ...item.result,
                projection: {
                  ...item.result.projection!,
                  kind: 'tool_start' as const,
                },
              }
            : null);
        if (start) {
          const startMessage = buildToolStartMessage(run, start);
          if (startMessage) {
            messages.push(startMessage);
          }
        }
        if (item.result) {
          const resultMessage = buildToolResultMessage(run, item.result);
          if (resultMessage) {
            messages.push(resultMessage);
          }
        }
      }
    }
    return messages.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }
}
