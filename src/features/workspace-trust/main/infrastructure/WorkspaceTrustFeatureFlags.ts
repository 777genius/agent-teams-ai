import { createLogger } from '@shared/utils/logger';

import type { WorkspaceTrustFeatureFlags } from '../../core/domain';

const logger = createLogger('WorkspaceTrustFeatureFlags');
const warnedMalformedFlags = new Set<string>();

function warnMalformedFlagOnce(name: string, value: string, defaultLabel: 'on' | 'off'): void {
  if (warnedMalformedFlags.has(name)) {
    return;
  }
  warnedMalformedFlags.add(name);
  logger.warn(
    `Ignoring malformed workspace trust feature flag ${name}=${JSON.stringify(
      value
    )}; using default ${defaultLabel}.`
  );
}

function parseDefaultOn(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === 'true' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off') {
    return false;
  }
  warnMalformedFlagOnce(name, value ?? '', 'on');
  return true;
}

function parseDefaultOff(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === '0' || normalized === 'false' || normalized === 'off') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'on') {
    return true;
  }
  warnMalformedFlagOnce(name, value ?? '', 'off');
  return false;
}

export function resolveWorkspaceTrustFeatureFlags(
  env: NodeJS.ProcessEnv = process.env
): WorkspaceTrustFeatureFlags {
  const enabledFlagName =
    env.AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT !== undefined
      ? 'AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT'
      : 'AGENT_TEAMS_WORKSPACE_TRUST';
  const enabledFlag = env.AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT ?? env.AGENT_TEAMS_WORKSPACE_TRUST;
  const enabled = parseDefaultOn(enabledFlagName, enabledFlag);
  const fileLockEnabled = false;
  const codexSettingsFlagName =
    env.AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS !== undefined
      ? 'AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS'
      : 'AGENT_TEAMS_WORKSPACE_TRUST_CODEX_ARGS';
  const codexSettingsFlag =
    env.AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS ?? env.AGENT_TEAMS_WORKSPACE_TRUST_CODEX_ARGS;
  return {
    enabled,
    claudePty:
      enabled &&
      parseDefaultOn(
        'AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY',
        env.AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY
      ),
    codexArgs: enabled && parseDefaultOn(codexSettingsFlagName, codexSettingsFlag),
    retry:
      enabled &&
      parseDefaultOff('AGENT_TEAMS_WORKSPACE_TRUST_RETRY', env.AGENT_TEAMS_WORKSPACE_TRUST_RETRY),
    fileLock: enabled && fileLockEnabled,
  };
}
