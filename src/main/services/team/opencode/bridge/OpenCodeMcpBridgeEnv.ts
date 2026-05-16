const DISABLED_HTTP_MCP_VALUES = new Set(['0', 'false', 'no', 'off']);

const LOCAL_MCP_LAUNCH_ENV_KEYS = [
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
] as const;

export type OpenCodeMcpBridgeEnv = Record<string, string | undefined>;

export function isOpenCodeMcpHttpBridgeEnabled(env: OpenCodeMcpBridgeEnv = process.env): boolean {
  const rawValue = env.CLAUDE_TEAM_OPENCODE_MCP_HTTP?.trim().toLowerCase();
  return rawValue ? !DISABLED_HTTP_MCP_VALUES.has(rawValue) : true;
}

export function hasOpenCodeLocalMcpLaunchEnv(env: OpenCodeMcpBridgeEnv): boolean {
  return LOCAL_MCP_LAUNCH_ENV_KEYS.every((key) => Boolean(env[key]?.trim()));
}

export function copyOpenCodeLocalMcpLaunchEnv(
  sourceEnv: OpenCodeMcpBridgeEnv,
  targetEnv: OpenCodeMcpBridgeEnv
): void {
  for (const key of LOCAL_MCP_LAUNCH_ENV_KEYS) {
    const value = sourceEnv[key]?.trim();
    if (value) {
      targetEnv[key] = value;
    } else {
      delete targetEnv[key];
    }
  }
}

export function snapshotOpenCodeLocalMcpLaunchEnv(
  env: OpenCodeMcpBridgeEnv
): OpenCodeMcpBridgeEnv | null {
  if (!hasOpenCodeLocalMcpLaunchEnv(env)) {
    return null;
  }

  const snapshot: OpenCodeMcpBridgeEnv = {};
  copyOpenCodeLocalMcpLaunchEnv(env, snapshot);
  return snapshot;
}

export function clearOpenCodeLocalMcpLaunchEnv(env: OpenCodeMcpBridgeEnv): void {
  for (const key of LOCAL_MCP_LAUNCH_ENV_KEYS) {
    delete env[key];
  }
}
