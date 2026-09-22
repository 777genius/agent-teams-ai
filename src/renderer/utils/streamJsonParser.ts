/**
 * Stream-JSON Parser
 *
 * Parses CLI stream-json stdout lines into AIGroupDisplayItem[] for rich rendering.
 * Used by CliLogsRichView to replace raw JSON display with beautiful components.
 */

import { getToolSummary } from '@renderer/utils/toolRendering/toolSummaryHelpers';
import { summarizeAgentToolInput } from '@shared/utils/toolSummary';

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

interface CodexNativeJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
    status?: string;
    command?: string;
    aggregated_output?: string;
    output?: string;
    stderr?: string;
    exit_code?: number;
    exitCode?: number;
    changes?: unknown;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface CodexNativeProjectedSystemEvent {
  type?: string;
  subtype?: string;
  content?: string;
  level?: string;
  codexNativeThreadStatus?: string;
  codexNativeThreadId?: string;
}

/**
 * Content-based hash for deterministic fallback IDs that survive
 * line reordering and pagination changes.
 * Caps input length to avoid hashing huge payloads.
 */
function stableHash(s: string): string {
  let h = 0;
  const len = Math.min(s.length, 500);
  for (let i = 0; i < len; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractCodexToolResultText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  const record = asRecord(value);
  const content = record?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => asRecord(block))
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((entry) => entry.trim().length > 0)
      .join('\n')
      .trim();
    if (text) return text;
  }

  if (record?.structured_content != null) {
    return JSON.stringify(record.structured_content);
  }

  return null;
}

function extractCodexToolErrorText(value: unknown): string | null {
  const record = asRecord(value);
  const message = record?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

function getCodexToolDisplayName(serverName: string, toolName: string): string {
  return serverName === 'agent-teams' ? `agent-teams_${toolName}` : `${serverName}_${toolName}`;
}

function readRawString(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function readFiniteNumber(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createCodexMcpToolItem(
  event: CodexNativeJsonEvent,
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem | null {
  const item = event.item;
  if (
    (event.type !== 'item.started' && event.type !== 'item.completed') ||
    item?.type !== 'mcp_tool_call' ||
    typeof item.server !== 'string' ||
    typeof item.tool !== 'string'
  ) {
    return null;
  }

  const input = asRecord(item.arguments) ?? {};
  const status = typeof item.status === 'string' && item.status.trim() ? item.status : 'unknown';
  const errorText = extractCodexToolErrorText(item.error);
  const resultText = extractCodexToolResultText(item.result);
  const isCompleted = event.type === 'item.completed';
  const toolName = getCodexToolDisplayName(item.server, item.tool);
  const linkedTool: LinkedToolItem = {
    id: item.id ?? `codex-tool-L${lineIndex}`,
    name: toolName,
    input,
    inputPreview: getToolSummary(toolName, input),
    startTime: timestamp,
    isOrphaned: !isCompleted,
  };

  if (isCompleted) {
    linkedTool.endTime = timestamp;
    linkedTool.isOrphaned = false;
    if (resultText || errorText) {
      linkedTool.result = {
        content: resultText ?? errorText ?? '',
        isError: status === 'failed' || errorText !== null,
      };
      linkedTool.outputPreview = resultText ?? errorText ?? undefined;
    }
  }

  return { type: 'tool', tool: linkedTool };
}

function createCodexCommandExecutionToolItem(
  event: CodexNativeJsonEvent,
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem | null {
  const item = event.item;
  if (
    (event.type !== 'item.started' && event.type !== 'item.completed') ||
    item?.type !== 'command_execution'
  ) {
    return null;
  }

  const isCompleted = event.type === 'item.completed';
  const itemRecord = asRecord(item) ?? {};
  const command = readRawString(itemRecord, 'command') ?? '';
  const status =
    typeof item.status === 'string' && item.status.trim()
      ? item.status
      : isCompleted
        ? 'unknown'
        : 'in_progress';
  const exitCode =
    readFiniteNumber(itemRecord, 'exit_code') ?? readFiniteNumber(itemRecord, 'exitCode');
  const output =
    readRawString(itemRecord, 'aggregated_output') ??
    readRawString(itemRecord, 'output') ??
    readRawString(itemRecord, 'stderr') ??
    '';
  const input = { command };
  const linkedTool: LinkedToolItem = {
    id: item.id ?? `codex-command-L${lineIndex}`,
    name: 'Bash',
    input,
    inputPreview: getToolSummary('Bash', input),
    startTime: timestamp,
    isOrphaned: !isCompleted,
  };

  if (isCompleted) {
    const isError =
      status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0);
    linkedTool.endTime = timestamp;
    linkedTool.isOrphaned = false;
    linkedTool.result = {
      content: output,
      isError,
    };
    linkedTool.outputPreview = output || undefined;
  }

  return { type: 'tool', tool: linkedTool };
}

function getFirstFileChangePath(changes: unknown[]): string {
  for (const change of changes) {
    const record = asRecord(change);
    if (typeof record?.path === 'string' && record.path.trim()) {
      return record.path;
    }
  }
  return '';
}

function formatFileChangesResult(changes: unknown[]): string {
  const rows = changes.map((change) => {
    const record = asRecord(change);
    const path =
      typeof record?.path === 'string' && record.path.trim() ? record.path : '(unknown path)';
    const kind = typeof record?.kind === 'string' && record.kind.trim() ? record.kind : 'update';
    return `- ${path} (${kind})`;
  });
  return ['File changes:', ...rows].join('\n');
}

function createCodexFileChangeToolItem(
  event: CodexNativeJsonEvent,
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem | null {
  const item = event.item;
  if (
    (event.type !== 'item.started' && event.type !== 'item.completed') ||
    item?.type !== 'file_change'
  ) {
    return null;
  }

  const isCompleted = event.type === 'item.completed';
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const input = {
    file_path: getFirstFileChangePath(changes),
    changes,
  };
  const status =
    typeof item.status === 'string' && item.status.trim()
      ? item.status
      : isCompleted
        ? 'unknown'
        : 'in_progress';
  const linkedTool: LinkedToolItem = {
    id: item.id ?? `codex-file-change-L${lineIndex}`,
    name: 'Edit',
    input,
    inputPreview: getToolSummary('Edit', input),
    startTime: timestamp,
    isOrphaned: !isCompleted,
  };

  if (isCompleted) {
    const resultContent = formatFileChangesResult(changes);
    linkedTool.endTime = timestamp;
    linkedTool.isOrphaned = false;
    linkedTool.result = {
      content: resultContent,
      isError: status === 'failed',
    };
    linkedTool.outputPreview = resultContent;
  }

  return { type: 'tool', tool: linkedTool };
}

function createCodexToolItem(
  event: CodexNativeJsonEvent,
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem | null {
  return (
    createCodexMcpToolItem(event, timestamp, lineIndex) ??
    createCodexCommandExecutionToolItem(event, timestamp, lineIndex) ??
    createCodexFileChangeToolItem(event, timestamp, lineIndex)
  );
}

function codexNativeEventToDisplayItems(
  parsed: unknown,
  timestamp: Date,
  lineIndex: number
): AIGroupDisplayItem[] | null {
  const event = asRecord(parsed) as CodexNativeJsonEvent | null;
  if (!event || typeof event.type !== 'string') {
    return null;
  }

  if (event.type === 'thread.started') {
    const threadId =
      typeof event.thread_id === 'string' && event.thread_id.trim()
        ? `: ${event.thread_id.trim()}`
        : '';
    return [{ type: 'output', content: `Codex native thread started${threadId}.`, timestamp }];
  }

  if (event.type === 'turn.started') {
    return [{ type: 'output', content: 'Codex turn started.', timestamp }];
  }

  if (event.type === 'turn.completed') {
    const usage = event.usage;
    const usageParts = [
      typeof usage?.input_tokens === 'number' ? `${usage.input_tokens} input` : null,
      typeof usage?.cached_input_tokens === 'number' ? `${usage.cached_input_tokens} cached` : null,
      typeof usage?.output_tokens === 'number' ? `${usage.output_tokens} output` : null,
    ].filter((part): part is string => Boolean(part));
    const suffix = usageParts.length > 0 ? ` (${usageParts.join(', ')} tokens)` : '';
    return [{ type: 'output', content: `Codex turn completed${suffix}.`, timestamp }];
  }

  if (
    event.type === 'item.completed' &&
    event.item?.type === 'agent_message' &&
    typeof event.item.text === 'string' &&
    event.item.text.trim()
  ) {
    return [{ type: 'output', content: event.item.text.trim(), timestamp }];
  }

  const toolItem = createCodexToolItem(event, timestamp, lineIndex);
  if (toolItem) {
    return [toolItem];
  }

  return null;
}

function codexNativeProjectedSystemToDisplayItems(
  parsed: unknown,
  timestamp: Date
): AIGroupDisplayItem[] | null {
  const event = asRecord(parsed) as CodexNativeProjectedSystemEvent | null;
  if (event?.type !== 'system' || typeof event.subtype !== 'string') {
    return null;
  }

  if (
    event.subtype !== 'codex_native_thread_status' &&
    event.subtype !== 'codex_native_warning' &&
    event.subtype !== 'codex_native_execution_summary'
  ) {
    return null;
  }

  const content =
    typeof event.content === 'string' && event.content.trim()
      ? event.content.trim()
      : event.subtype === 'codex_native_thread_status'
        ? `Codex native thread ${event.codexNativeThreadStatus ?? 'status'}${
            event.codexNativeThreadId ? `: ${event.codexNativeThreadId}` : ''
          }.`
        : null;

  return content ? [{ type: 'output', content, timestamp }] : null;
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
  // Track how many times each messageId / hash has been seen to disambiguate duplicates
  const msgIdOccurrences = new Map<string, number>();
  const hashOccurrences = new Map<string, number>();

  const ensureCurrentTimestamp = (line: string): Date => {
    if (currentTimestamp) return currentTimestamp;
    // Use stable cached timestamp keyed by line content to survive re-parses
    let ts = lineTimestampCache.get(line);
    if (!ts) {
      ts = new Date();
      if (lineTimestampCache.size >= MAX_TIMESTAMP_CACHE_SIZE) {
        // Evict oldest entry (first inserted)
        const firstKey = lineTimestampCache.keys().next().value!;
        lineTimestampCache.delete(firstKey);
      }
      lineTimestampCache.set(line, ts);
    }
    currentTimestamp = ts;
    return ts;
  };

  const ensureCurrentGroupId = (
    line: string,
    parsed: unknown,
    lineAgentId: string | undefined
  ): void => {
    if (currentGroupId) return;
    currentAgentId = lineAgentId;
    const msgId = extractAssistantMessageId(parsed);
    if (msgId) {
      const occurrence = msgIdOccurrences.get(msgId) ?? 0;
      msgIdOccurrences.set(msgId, occurrence + 1);
      currentGroupId =
        occurrence === 0 ? `stream-group-${msgId}` : `stream-group-${msgId}-${occurrence}`;
      return;
    }

    // Content-hash fallback: deterministic and survives line reordering
    const h = stableHash(line);
    const occ = hashOccurrences.get(h) ?? 0;
    hashOccurrences.set(h, occ + 1);
    currentGroupId = occ === 0 ? `stream-group-H${h}` : `stream-group-H${h}-${occ}`;
  };

  const pushItems = (items: AIGroupDisplayItem[]): void => {
    for (const item of items) {
      if (item.type !== 'tool') {
        currentItems.push(item);
        continue;
      }

      const existingIndex = currentItems.findIndex(
        (entry) => entry.type === 'tool' && entry.tool.id === item.tool.id
      );
      if (existingIndex === -1) {
        currentItems.push(item);
      } else {
        currentItems[existingIndex] = item;
      }
    }
  };

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
      // Non-JSON line (stderr debug output, truncated data, etc.)
      // Show as raw output so the user can see CLI stderr activity.
      if (trimmed.length > 0) {
        if (!currentTimestamp) currentTimestamp = new Date();
        if (!currentGroupId) currentGroupId = `stderr-${groups.length}-${lineIndex}`;
        currentItems.push({
          type: 'output',
          content: trimmed,
          timestamp: currentTimestamp,
        });
      }
      continue;
    }

    const blocks = extractContentBlocks(parsed);
    if (!blocks) {
      const timestamp = ensureCurrentTimestamp(trimmed);
      const codexItems =
        codexNativeEventToDisplayItems(parsed, timestamp, lineIndex) ??
        codexNativeProjectedSystemToDisplayItems(parsed, timestamp);
      if (codexItems && codexItems.length > 0) {
        ensureCurrentGroupId(trimmed, parsed, undefined);
        pushItems(codexItems);
        continue;
      }

      // Valid JSON but not a displayable log event — flush and skip
      flushGroup();
      continue;
    }

    // Extract agentId from top-level (subagent messages have it, lead messages don't)
    const lineAgentId =
      typeof (parsed as Record<string, unknown>).agentId === 'string'
        ? ((parsed as Record<string, unknown>).agentId as string)
        : undefined;

    const timestamp = ensureCurrentTimestamp(trimmed);
    ensureCurrentGroupId(trimmed, parsed, lineAgentId);

    const items = contentBlocksToDisplayItems(blocks, timestamp, lineIndex);
    pushItems(items);
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
    // Anchor section ID on first group's stable ID instead of occurrence count
    const firstGroupId = currentRun.groups[0]?.id ?? '';
    const sectionId = `subagent-${currentRun.agentId}-${stableHash(firstGroupId)}`;
    result.push({
      type: 'subagent-section',
      section: {
        id: sectionId,
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
            (item.tool.name === 'Agent' && input ? summarizeAgentToolInput(input, 80) : null) ||
            (typeof input?.description === 'string' && input.description) ||
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
