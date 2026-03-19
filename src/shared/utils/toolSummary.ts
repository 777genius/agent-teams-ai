import type { ToolCallMeta } from '@shared/types';

export interface ToolSummaryData {
  total: number;
  byName: Record<string, number>;
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
    case 'TaskCreate':
      return typeof input.prompt === 'string'
        ? input.prompt
        : typeof input.description === 'string'
          ? input.description
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
      const v = input.name ?? input.path ?? input.file ?? input.query ?? input.command;
      return typeof v === 'string' ? truncateStr(v, 50) : undefined;
    }
  }
}
