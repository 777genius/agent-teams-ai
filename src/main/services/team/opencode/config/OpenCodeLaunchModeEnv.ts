import type { OpenCodeTeamLaunchMode } from '../bridge/OpenCodeBridgeCommandContract';

export const CLAUDE_TEAM_OPENCODE_LAUNCH_MODE_ENV = 'CLAUDE_TEAM_OPENCODE_LAUNCH_MODE';
export const CLAUDE_TEAM_OPENCODE_DOGFOOD_ENV = 'CLAUDE_TEAM_OPENCODE_DOGFOOD';

export function resolveOpenCodeTeamLaunchModeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): OpenCodeTeamLaunchMode {
  const raw = env[CLAUDE_TEAM_OPENCODE_LAUNCH_MODE_ENV]?.trim().toLowerCase();
  if (raw === 'dogfood' || raw === 'production' || raw === 'disabled') {
    return raw;
  }
  if (env[CLAUDE_TEAM_OPENCODE_DOGFOOD_ENV] === '1') {
    return 'dogfood';
  }
  return 'production';
}
