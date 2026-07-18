const DISABLED_HTTP_MCP_VALUES = new Set(['0', 'false', 'no', 'off']);

const LOCAL_MCP_LAUNCH_ENV_KEYS = [
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
] as const;
const OPTIONAL_LOCAL_MCP_LAUNCH_ENV_KEYS = ['CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON'] as const;
const LEGACY_LOCAL_MCP_CHILD_ENV_KEYS = ['ELECTRON_RUN_AS_NODE'] as const;
const MANAGED_HOST_APP_INSTANCE_FRAGMENT_KEY = 'agent-teams-app-instance';

export type OpenCodeMcpBridgeEnv = Record<string, string | undefined>;

function normalizeOpenCodeAppInstanceId(appInstanceId: string): string {
  const normalizedAppInstanceId = appInstanceId.trim();
  if (!normalizedAppInstanceId) {
    throw new Error('OpenCode app instance id is required');
  }
  return normalizedAppInstanceId;
}

export function buildOpenCodeAppScopedMcpOwnershipMarker(appInstanceId: string): string {
  const fragment = new URLSearchParams();
  fragment.set(
    MANAGED_HOST_APP_INSTANCE_FRAGMENT_KEY,
    normalizeOpenCodeAppInstanceId(appInstanceId)
  );
  return fragment.toString();
}

export function buildOpenCodeAppScopedMcpUrl(baseUrl: string, appInstanceId: string): string {
  const url = new URL(baseUrl);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  fragment.set(
    MANAGED_HOST_APP_INSTANCE_FRAGMENT_KEY,
    normalizeOpenCodeAppInstanceId(appInstanceId)
  );
  url.hash = fragment.toString();
  return url.toString();
}

export function mergeOpenCodeLocalMcpChildEnvironment(
  env: OpenCodeMcpBridgeEnv,
  additions: Readonly<Record<string, string>>
): void {
  const rawEnvironment = env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON?.trim();
  let currentEnvironment: Record<string, string> = {};
  if (rawEnvironment) {
    try {
      const parsed = JSON.parse(rawEnvironment) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        currentEnvironment = Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] => {
            return typeof entry[1] === 'string';
          })
        );
      }
    } catch {
      // Replace malformed optional child environment with the required safe values.
    }
  }

  env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({
    ...currentEnvironment,
    ...additions,
  });
}

export function isOpenCodeMcpHttpBridgeEnabled(env: OpenCodeMcpBridgeEnv = process.env): boolean {
  const rawValue = env.CLAUDE_TEAM_OPENCODE_MCP_HTTP?.trim().toLowerCase();
  return rawValue ? !DISABLED_HTTP_MCP_VALUES.has(rawValue) : true;
}

export function hasOpenCodeLocalMcpLaunchEnv(env: OpenCodeMcpBridgeEnv): boolean {
  return LOCAL_MCP_LAUNCH_ENV_KEYS.every((key) => Boolean(env[key]?.trim()));
}

function buildLegacyLocalMcpEnvJson(env: OpenCodeMcpBridgeEnv): string | null {
  const legacyEnv: Record<string, string> = {};
  for (const key of LEGACY_LOCAL_MCP_CHILD_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      legacyEnv[key] = value;
    }
  }
  return Object.keys(legacyEnv).length > 0 ? JSON.stringify(legacyEnv) : null;
}

export function shouldEnsureOpenCodeLocalMcpLaunchEnv(input: {
  httpBridgeEnabled: boolean;
  mcpUrl: string | undefined;
}): boolean {
  return input.httpBridgeEnabled || !input.mcpUrl?.trim();
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
  for (const key of OPTIONAL_LOCAL_MCP_LAUNCH_ENV_KEYS) {
    const value = sourceEnv[key]?.trim();
    if (value) {
      targetEnv[key] = value;
    } else {
      delete targetEnv[key];
    }
  }
  if (!targetEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON?.trim()) {
    const legacyEnvJson = buildLegacyLocalMcpEnvJson(sourceEnv);
    if (legacyEnvJson) {
      targetEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = legacyEnvJson;
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
  for (const key of OPTIONAL_LOCAL_MCP_LAUNCH_ENV_KEYS) {
    delete env[key];
  }
  for (const key of LEGACY_LOCAL_MCP_CHILD_ENV_KEYS) {
    delete env[key];
  }
}
