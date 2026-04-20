import type { ToolCallMeta } from '@shared/types';

export interface ToolSummaryData {
  total: number;
  byName: Record<string, number>;
}

export type AgentToolDuplicateSkipReason = 'already_running' | 'bootstrap_pending';

export interface ParsedAgentToolResultStatus {
  status: 'duplicate_skipped';
  reason?: AgentToolDuplicateSkipReason;
  rawReason?: string;
  name?: string;
  teamName?: string;
}

export function buildToolSummary(content: Record<string, unknown>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      block.type === 'tool_use' &&
      typeof block.name === 'string'
    ) {
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
    }
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  return `${total} ${total === 1 ? 'tool' : 'tools'}`;
}

export function parseToolSummary(summary: string | undefined): ToolSummaryData | null {
  if (!summary) return null;
  // Support new format: "3 tools"
  const simpleMatch = /^(\d+)\s+tools?$/.exec(summary);
  if (simpleMatch) {
    return { total: parseInt(simpleMatch[1], 10), byName: {} };
  }
  // Support legacy format: "3 tools (Read, 2 Edit)"
  const match = /^(\d+)\s+tools?\s+\(([^)]+)\)$/.exec(summary);
  if (!match) return null;
  const byName: Record<string, number> = {};
  for (const part of match[2].split(', ')) {
    const m =
      // eslint-disable-next-line security/detect-unsafe-regex -- part from split, bounded by summary
      /^(\d+)\s+(\S+(?:\s+\S+)*)$/.exec(part);
    if (m) {
      byName[m[2]] = parseInt(m[1], 10);
    } else {
      byName[part] = 1;
    }
  }
  return { total: parseInt(match[1], 10), byName };
}

export function formatToolSummary(data: ToolSummaryData): string {
  return `${data.total} ${data.total === 1 ? 'tool' : 'tools'}`;
}

/** Format tool summary directly from a Map<toolName, count>. */
export function formatToolSummaryFromMap(counts: Map<string, number>): string | undefined {
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  return `${total} ${total === 1 ? 'tool' : 'tools'}`;
}

/** Format tool summary from an array of ToolCallMeta. */
export function formatToolSummaryFromCalls(calls: ToolCallMeta[]): string | undefined {
  if (calls.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return formatToolSummaryFromMap(counts);
}

function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

function truncateStr(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max) + '...';
}

function formatProviderName(providerId: string): string {
  switch (providerId.trim().toLowerCase()) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    default:
      return providerId;
  }
}

function formatEffortName(effort: string): string {
  const trimmed = effort.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

export interface AgentToolDisplayDetails {
  action: string;
  teammateName?: string;
  teamName?: string;
  runtime?: string;
  subagentType?: string;
}

export function getAgentToolDisplayDetails(
  input: Record<string, unknown>
): AgentToolDisplayDetails {
  const teammateName = typeof input.name === 'string' ? input.name.trim() || undefined : undefined;
  const teamName =
    typeof input.team_name === 'string' ? input.team_name.trim() || undefined : undefined;
  const description =
    typeof input.description === 'string' ? input.description.trim() || undefined : undefined;
  const provider =
    typeof input.provider === 'string'
      ? formatProviderName(input.provider)
      : typeof input.providerId === 'string'
        ? formatProviderName(input.providerId)
        : undefined;
  const model = typeof input.model === 'string' ? input.model.trim() || undefined : undefined;
  const effort = typeof input.effort === 'string' ? formatEffortName(input.effort) : undefined;
  const subagentType =
    typeof input.subagent_type === 'string'
      ? input.subagent_type.trim() || undefined
      : typeof input.subagentType === 'string'
        ? input.subagentType.trim() || undefined
        : undefined;

  const runtimeParts = [provider, model, effort].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  );
  const runtime = runtimeParts.length > 0 ? runtimeParts.join(' · ') : undefined;

  return {
    action: description ?? (teammateName ? `Spawn teammate ${teammateName}` : 'Spawn subagent'),
    teammateName,
    teamName,
    runtime,
    subagentType,
  };
}

export function summarizeAgentToolInput(input: Record<string, unknown>, max = 60): string {
  const details = getAgentToolDisplayDetails(input);
  const text = details.runtime ? `${details.action} · ${details.runtime}` : details.action;
  return truncateStr(text, max);
}

/** Extract a short human-readable preview from tool_use input arguments. */
export function extractToolPreview(
  name: string,
  input: Record<string, unknown>
): string | undefined {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return typeof input.file_path === 'string' ? baseName(input.file_path) : undefined;
    case 'Bash':
      return typeof input.description === 'string'
        ? truncateStr(input.description, 60)
        : typeof input.command === 'string'
          ? truncateStr(input.command, 60)
          : undefined;
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? truncateStr(input.pattern, 40) : undefined;
    case 'Agent':
    case 'Task':
    case 'TaskCreate':
      if (name === 'Agent') {
        return summarizeAgentToolInput(input, 80);
      }
      return typeof input.description === 'string'
        ? input.description
        : typeof input.prompt === 'string'
          ? truncateStr(input.prompt, 80)
          : undefined;
    case 'WebFetch':
      if (typeof input.url === 'string') {
        try {
          return new URL(input.url).hostname;
        } catch {
          return truncateStr(input.url, 40);
        }
      }
      return undefined;
    case 'WebSearch':
      return typeof input.query === 'string' ? truncateStr(input.query, 40) : undefined;
    default: {
      const v =
        input.subject ??
        input.name ??
        input.description ??
        input.prompt ??
        input.path ??
        input.file ??
        input.query ??
        input.command;
      return typeof v === 'string' ? truncateStr(v, 50) : undefined;
    }
  }
}

function flattenToolResultContent(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (typeof block.content === 'string') {
      parts.push(block.content);
    }
  }
  return parts;
}

/** Extract a short human-readable preview from tool_result content. */
export function extractToolResultPreview(content: unknown, max = 80): string | undefined {
  const joined = flattenToolResultContent(content).join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return undefined;
  return truncateStr(joined, max);
}

/**
 * Parse machine-readable Agent tool_result status lines from the raw tool_result content.
 * Returns null for any non-Agent or non-duplicate result.
 */
export function parseAgentToolResultStatus(content: unknown): ParsedAgentToolResultStatus | null {
  const joined = flattenToolResultContent(content).join('\n').trim();
  if (!joined) return null;

  const fields = new Map<string, string>();
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    fields.set(key, value);
  }

  if (fields.get('status') !== 'duplicate_skipped') {
    return null;
  }

  const rawReason = fields.get('reason');
  const reason =
    rawReason === 'already_running' || rawReason === 'bootstrap_pending' ? rawReason : undefined;

  return {
    status: 'duplicate_skipped',
    reason,
    ...(rawReason ? { rawReason } : {}),
    name: fields.get('name'),
    teamName: fields.get('team_name'),
  };
}
