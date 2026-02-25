/**
 * Stream-JSON Parser
 *
 * Parses CLI stream-json stdout lines into AIGroupDisplayItem[] for rich rendering.
 * Used by CliLogsRichView to replace raw JSON display with beautiful components.
 */

import { getToolSummary } from '@renderer/utils/toolRendering/toolSummaryHelpers';

import type { AIGroupDisplayItem, LinkedToolItem } from '@renderer/types/groups';

/**
 * A group of display items from one or more consecutive assistant messages.
 */
export interface StreamJsonGroup {
  /** Unique group ID */
  id: string;
  /** Display items within this group */
  items: AIGroupDisplayItem[];
  /** Human-readable summary (e.g. "1 thinking, 2 tool calls") */
  summary: string;
  /** Timestamp of first message in group */
  timestamp: Date;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Attempts to extract the content array from a parsed stream-json line.
 * Handles both `{ type: "assistant", content: [...] }` and
 * `{ message: { type: "assistant", content: [...] } }` formats.
 */
function extractContentBlocks(parsed: unknown): ContentBlock[] | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;

  // Direct format: { type: "assistant", content: [...] }
  if (obj.type === 'assistant' && Array.isArray(obj.content)) {
    return obj.content as ContentBlock[];
  }

  // Wrapped format: { message: { type: "assistant", content: [...] } }
  if (obj.message && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>;
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      return msg.content as ContentBlock[];
    }
  }

  // Result format: { type: "result", result: { type: "assistant", content: [...] } }
  if (obj.type === 'result' && obj.result && typeof obj.result === 'object') {
    const result = obj.result as Record<string, unknown>;
    if (Array.isArray(result.content)) {
      return result.content as ContentBlock[];
    }
  }

  return null;
}

/**
 * Converts content blocks from a single assistant message into display items.
 * @param lineIndex - stable line position for deterministic fallback IDs
 */
function contentBlocksToDisplayItems(
  blocks: ContentBlock[],
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem[] {
  const items: AIGroupDisplayItem[] = [];

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];
    switch (block.type) {
      case 'thinking': {
        const text = block.thinking ?? '';
        if (text.trim()) {
          items.push({ type: 'thinking', content: text, timestamp });
        }
        break;
      }

      case 'text': {
        const text = block.text ?? '';
        if (text.trim()) {
          items.push({ type: 'output', content: text, timestamp });
        }
        break;
      }

      case 'tool_use': {
        const input = block.input ?? {};
        const toolName = block.name ?? 'Unknown';
        const linkedTool: LinkedToolItem = {
          id: block.id ?? `stream-tool-L${lineIndex}-B${blockIdx}`,
          name: toolName,
          input,
          inputPreview: getToolSummary(toolName, input),
          startTime: timestamp,
          isOrphaned: true,
        };
        items.push({ type: 'tool', tool: linkedTool });
        break;
      }
    }
  }

  return items;
}

/**
 * Builds a human-readable summary string from display items.
 */
function buildGroupSummary(items: AIGroupDisplayItem[]): string {
  let thinkingCount = 0;
  let toolCount = 0;
  let outputCount = 0;

  for (const item of items) {
    switch (item.type) {
      case 'thinking':
        thinkingCount++;
        break;
      case 'tool':
        toolCount++;
        break;
      case 'output':
        outputCount++;
        break;
    }
  }

  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount > 1 ? 's' : ''}`);
  if (outputCount > 0) parts.push(`${outputCount} output${outputCount > 1 ? 's' : ''}`);

  return parts.join(', ') || 'empty';
}

/**
 * Parses stream-json CLI output lines into structured groups for rich rendering.
 *
 * Each group represents one or more consecutive assistant messages.
 * Non-assistant lines (markers, errors, etc.) are silently skipped.
 */
export function parseStreamJsonToGroups(cliLogsTail: string): StreamJsonGroup[] {
  if (!cliLogsTail.trim()) return [];

  const lines = cliLogsTail.split('\n');
  const groups: StreamJsonGroup[] = [];
  let currentItems: AIGroupDisplayItem[] = [];
  let currentTimestamp: Date | null = null;
  let groupCounter = 0;
  // Stable timestamp for the entire parse (deterministic across re-renders)
  const parseTimestamp = new Date();

  const flushGroup = (): void => {
    if (currentItems.length > 0 && currentTimestamp) {
      groups.push({
        id: `stream-group-${groupCounter++}`,
        items: currentItems,
        summary: buildGroupSummary(currentItems),
        timestamp: currentTimestamp,
      });
      currentItems = [];
      currentTimestamp = null;
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex].trim();

    // Skip empty lines and stream markers
    if (!trimmed || trimmed.startsWith('[stdout]') || trimmed.startsWith('[stderr]')) {
      continue;
    }

    // Try to parse as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (truncated, marker, etc.) — flush and skip
      flushGroup();
      continue;
    }

    const blocks = extractContentBlocks(parsed);
    if (!blocks) {
      // Valid JSON but not an assistant message — flush and skip
      flushGroup();
      continue;
    }

    if (!currentTimestamp) currentTimestamp = parseTimestamp;

    const items = contentBlocksToDisplayItems(blocks, parseTimestamp, lineIndex);
    currentItems.push(...items);
  }

  // Flush remaining items
  flushGroup();

  return groups;
}
