const AGENT_TEAMS_PREFIXES = [
  'mcp__agent-teams__',
  'mcp__agent_teams__',
  'agent-teams_',
  'agent_teams_',
] as const;

const TASK_BOUNDARY_TOOL_NAMES = ['task_start', 'task_complete', 'task_set_status'] as const;
const TASK_BOUNDARY_TOOL_SET = new Set<string>(TASK_BOUNDARY_TOOL_NAMES);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TASK_BOUNDARY_TOOL_LINE_PATTERN = new RegExp(
  `"name"\\s*:\\s*"(?:${[
    ...TASK_BOUNDARY_TOOL_NAMES,
    ...TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `proxy_${toolName}`),
    ...AGENT_TEAMS_PREFIXES.flatMap((prefix) =>
      TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `${prefix}${toolName}`)
    ),
    ...AGENT_TEAMS_PREFIXES.flatMap((prefix) =>
      TASK_BOUNDARY_TOOL_NAMES.map((toolName) => `proxy_${prefix}${toolName}`)
    ),
  ]
    .map(escapeRegex)
    .join('|')})"`
);

export function canonicalizeAgentTeamsToolName(rawName: string): string {
  const normalized = rawName.trim().replace(/^proxy_/, '');

  for (const prefix of AGENT_TEAMS_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }

  return normalized;
}

export function isAgentTeamsToolName(rawName: string, canonicalName: string): boolean {
  return canonicalizeAgentTeamsToolName(rawName).toLowerCase() === canonicalName.toLowerCase();
}

export function isAgentTeamsToolUse(input: {
  rawName: string;
  canonicalName: string;
  toolInput?: Record<string, unknown>;
  currentTeamName?: string;
}): boolean {
  const rawName = input.rawName.trim();
  const normalizedRawName = rawName.replace(/^proxy_/, '');
  const canonical = canonicalizeAgentTeamsToolName(rawName);
  if (canonical.toLowerCase() !== input.canonicalName.toLowerCase()) {
    return false;
  }

  const hasKnownPrefix = AGENT_TEAMS_PREFIXES.some((prefix) =>
    normalizedRawName.startsWith(prefix)
  );
  if (hasKnownPrefix) {
    return true;
  }

  if (input.canonicalName === 'message_send') {
    return (
      typeof input.toolInput?.teamName === 'string' &&
      input.toolInput.teamName === input.currentTeamName &&
      typeof input.toolInput?.to === 'string' &&
      typeof input.toolInput?.text === 'string'
    );
  }

  if (input.canonicalName === 'cross_team_send') {
    return (
      typeof input.toolInput?.teamName === 'string' &&
      input.toolInput.teamName === input.currentTeamName &&
      typeof input.toolInput?.toTeam === 'string' &&
      typeof input.toolInput?.text === 'string'
    );
  }

  return false;
}

export function isAgentTeamsTaskBoundaryToolName(rawName: string): boolean {
  return TASK_BOUNDARY_TOOL_SET.has(canonicalizeAgentTeamsToolName(rawName));
}

export function lineHasAgentTeamsTaskBoundaryToolName(line: string): boolean {
  return TASK_BOUNDARY_TOOL_LINE_PATTERN.test(line);
}
