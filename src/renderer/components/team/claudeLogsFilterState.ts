export type ClaudeLogStream = 'stdout' | 'stderr';
export type ClaudeLogKind = 'output' | 'thinking' | 'tool';

export interface ClaudeLogsFilterState {
  streams: Set<ClaudeLogStream>;
  kinds: Set<ClaudeLogKind>;
}

export const DEFAULT_CLAUDE_LOGS_FILTER: ClaudeLogsFilterState = {
  streams: new Set<ClaudeLogStream>(['stdout', 'stderr']),
  kinds: new Set<ClaudeLogKind>(['output', 'thinking', 'tool']),
};
