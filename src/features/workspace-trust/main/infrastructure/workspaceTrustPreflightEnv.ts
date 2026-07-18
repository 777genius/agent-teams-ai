import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';

const EXACT_STRIP_ENV_KEYS = new Set([
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP',
  'CLAUDE_TEAM_CONTROL_URL',
  'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE',
  'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER',
  'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_GEMINI_BACKEND',
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
  'OPENCODE_BIN_PATH',
  'CODEX_HOME',
]);

const STRIP_ENV_PREFIXES = [
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_',
  'AGENT_TEAMS_MCP_',
  'CLAUDE_TEAM_BOOTSTRAP_',
];

export function buildWorkspaceTrustPreflightEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(output)) {
    if (
      EXACT_STRIP_ENV_KEYS.has(key) ||
      STRIP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete output[key];
    }
  }
  return output;
}
