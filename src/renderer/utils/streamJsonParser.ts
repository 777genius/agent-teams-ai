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
  /** If set, this group belongs to a subagent (not the lead). */
  agentId?: string;
}

/** A subagent section wrapping consecutive groups from the same agentId. */
export interface SubagentSection {
  id: string;
  agentId: string;
  /** Human-readable description from the Agent tool_use that spawned this subagent */
  description: string;
  groups: StreamJsonGroup[];
  toolCount: number;
  timestamp: Date;
}

/** Union type for the final render list after subagent grouping. */
export type StreamJsonEntry =
  | { type: 'group'; group: StreamJsonGroup }
  | { type: 'subagent-section'; section: SubagentSection };

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
 * Handles both `{ type: "assistant", content: [...] }` (direct) and
 * `{ type: "assistant", message: { type: "message", content: [...] } }` (wrapped) formats.
 */
function extractContentBlocks(parsed: unknown): ContentBlock[] | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;

  // Only process assistant messages
  if (obj.type !== 'assistant') return null;

  // Direct format: { type: "assistant", content: [...] }
  if (Array.isArray(obj.content)) {
    return obj.content as ContentBlock[];
  }

  // Wrapped format: { type: "assistant", message: { type: "message", content: [...] } }
  // The inner message.type is "message" (not "assistant")
  if (obj.message && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      return msg.content as ContentBlock[];
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

function extractAssistantMessageId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'assistant') return null;

  // Direct format can include id at top-level
  if (typeof obj.id === 'string' && obj.id.trim()) return obj.id.trim();

  // Wrapped format: { type: "assistant", message: { id, ... } }
  const msg = obj.message;
  if (msg && typeof msg === 'object') {
    const inner = msg as Record<string, unknown>;
    if (typeof inner.id === 'string' && inner.id.trim()) return inner.id.trim();
  }

  return null;
}

/**
 * Module-level timestamp cache keyed by line content.
 * Ensures re-parses of the same log lines preserve their original timestamps
 * instead of getting new Date() each time.
 */
const lineTimestampCache = new Map<string, Date>();
const MAX_TIMESTAMP_CACHE_SIZE = 5000;

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
  let currentGroupId: string | null = null;
  let currentAgentId: string | undefined = undefined;
  // Track how many times each messageId has been seen to disambiguate duplicates
  const msgIdOccurrences = new Map<string, number>();

  const flushGroup = (): void => {
    if (currentItems.length > 0 && currentTimestamp) {
      const id = currentGroupId ?? `stream-group-fallback-${groups.length}`;
      groups.push({
        id,
        items: currentItems,
        summary: buildGroupSummary(currentItems),
        timestamp: currentTimestamp,
        agentId: currentAgentId,
      });
      currentItems = [];
      currentTimestamp = null;
      currentGroupId = null;
      currentAgentId = undefined;
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex].trim();

    // Skip empty lines; stream markers break groups
    if (!trimmed) continue;
    if (trimmed.startsWith('[stdout]') || trimmed.startsWith('[stderr]')) {
      flushGroup();
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

    // Extract agentId from top-level (subagent messages have it, lead messages don't)
    const lineAgentId =
      typeof (parsed as Record<string, unknown>).agentId === 'string'
        ? ((parsed as Record<string, unknown>).agentId as string)
        : undefined;

    if (!currentTimestamp) {
      // Use stable cached timestamp keyed by line content to survive re-parses
      let ts = lineTimestampCache.get(trimmed);
      if (!ts) {
        ts = new Date();
        if (lineTimestampCache.size >= MAX_TIMESTAMP_CACHE_SIZE) {
          // Evict oldest entry (first inserted)
          const firstKey = lineTimestampCache.keys().next().value!;
          lineTimestampCache.delete(firstKey);
        }
        lineTimestampCache.set(trimmed, ts);
      }
      currentTimestamp = ts;
    }
    if (!currentGroupId) {
      currentAgentId = lineAgentId;
      const msgId = extractAssistantMessageId(parsed);
      if (msgId) {
        const occurrence = msgIdOccurrences.get(msgId) ?? 0;
        msgIdOccurrences.set(msgId, occurrence + 1);
        currentGroupId =
          occurrence === 0 ? `stream-group-${msgId}` : `stream-group-${msgId}-${occurrence}`;
      } else {
        currentGroupId = `stream-group-L${lineIndex}`;
      }
    }

    const items = contentBlocksToDisplayItems(blocks, currentTimestamp, lineIndex);
    currentItems.push(...items);
  }

  // Flush remaining items
  flushGroup();

  return groups;
}

/**
 * Groups consecutive StreamJsonGroups by agentId into SubagentSections.
 * Lead groups (no agentId) remain as individual entries.
 * Must be called on chronological (oldest-first) groups.
 */
export function groupBySubagent(groups: StreamJsonGroup[]): StreamJsonEntry[] {
  const result: StreamJsonEntry[] = [];
  const pendingDescriptions: string[] = [];
  const agentDescMap = new Map<string, string>();
  const sectionCountByAgent = new Map<string, number>();
  let currentRun: { agentId: string; groups: StreamJsonGroup[] } | null = null;

  const flushRun = (): void => {
    if (!currentRun) return;
    const desc = agentDescMap.get(currentRun.agentId) ?? 'Subagent';
    let toolCount = 0;
    for (const g of currentRun.groups) {
      for (const item of g.items) {
        if (item.type === 'tool') toolCount++;
      }
    }
    const count = sectionCountByAgent.get(currentRun.agentId) ?? 0;
    sectionCountByAgent.set(currentRun.agentId, count + 1);
    const idSuffix = count > 0 ? `-${count}` : '';
    result.push({
      type: 'subagent-section',
      section: {
        id: `subagent-section-${currentRun.agentId}${idSuffix}`,
        agentId: currentRun.agentId,
        description: desc,
        groups: currentRun.groups,
        toolCount,
        timestamp: currentRun.groups[0].timestamp,
      },
    });
    currentRun = null;
  };

  for (const group of groups) {
    if (!group.agentId) {
      // Lead group — check for Agent/Task tool_use and extract description
      for (const item of group.items) {
        if (item.type === 'tool' && (item.tool.name === 'Agent' || item.tool.name === 'Task')) {
          const input = item.tool.input as Record<string, unknown> | undefined;
          const desc =
            (typeof input?.description === 'string' && input.description) ||
            (typeof input?.prompt === 'string' && input.prompt.slice(0, 80)) ||
            'Subagent';
          pendingDescriptions.push(desc);
        }
      }
      flushRun();
      result.push({ type: 'group', group });
    } else {
      // Subagent group
      if (!agentDescMap.has(group.agentId)) {
        agentDescMap.set(group.agentId, pendingDescriptions.shift() ?? 'Subagent');
      }

      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- optional chain narrows to `never` in loop body
      if (currentRun && currentRun.agentId === group.agentId) {
        currentRun.groups.push(group);
      } else {
        flushRun();
        currentRun = { agentId: group.agentId, groups: [group] };
      }
    }
  }

  flushRun();
  return result;
}
