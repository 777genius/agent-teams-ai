import { isTmuxRuntimeReadyForCurrentPlatform } from '@features/tmux-installer/main';
import { parseCliArgs } from '@shared/utils/cliArgsParser';

interface DesktopTeammateModeDecision {
  injectedTeammateMode: 'tmux' | null;
  forceProcessTeammates: boolean;
}

type DesktopTeammateMode = 'auto' | 'tmux' | 'in-process';

const DESKTOP_TEAMMATE_MODE_ENV = 'CLAUDE_TEAM_TEAMMATE_MODE';

let tmuxAvailablePromise: Promise<boolean> | null = null;

function getExplicitTeammateMode(rawExtraCliArgs: string | undefined): DesktopTeammateMode | null {
  const tokens = parseCliArgs(rawExtraCliArgs);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- parsing user-supplied CLI flags, not comparing secrets
    if (token === '--teammate-mode') {
      const next = tokens[i + 1];
      if (next === 'auto' || next === 'tmux' || next === 'in-process') {
        return next;
      }
      return null;
    }
    if (token.startsWith('--teammate-mode=')) {
      const value = token.slice('--teammate-mode='.length);
      if (value === 'auto' || value === 'tmux' || value === 'in-process') {
        return value;
      }
      return null;
    }
  }

  return null;
}

function normalizeDesktopTeammateMode(value: string | undefined): DesktopTeammateMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'auto' || normalized === 'tmux' || normalized === 'in-process'
    ? normalized
    : null;
}

function getEnvTeammateMode(env: NodeJS.ProcessEnv): DesktopTeammateMode | null {
  return normalizeDesktopTeammateMode(env[DESKTOP_TEAMMATE_MODE_ENV]);
}

async function isTmuxAvailable(): Promise<boolean> {
  if (!tmuxAvailablePromise) {
    tmuxAvailablePromise = isTmuxRuntimeReadyForCurrentPlatform()
      .then((value) => value)
      .catch(() => false)
      .finally(() => {
        tmuxAvailablePromise = null;
      });
  }

  return tmuxAvailablePromise;
}

export async function resolveDesktopTeammateModeDecision(
  rawExtraCliArgs: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<DesktopTeammateModeDecision> {
  const requestedMode = getExplicitTeammateMode(rawExtraCliArgs) ?? getEnvTeammateMode(env);
  if (requestedMode === 'tmux') {
    return {
      injectedTeammateMode: 'tmux',
      forceProcessTeammates: false,
    };
  }

  if (requestedMode === 'auto') {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: true,
    };
  }

  if (requestedMode === 'in-process') {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: false,
    };
  }

  await isTmuxAvailable();

  return {
    injectedTeammateMode: null,
    forceProcessTeammates: true,
  };
}

export function applyDesktopTeammateModeDecisionToEnv(
  env: NodeJS.ProcessEnv,
  decision: Pick<DesktopTeammateModeDecision, 'forceProcessTeammates'>
): void {
  if (decision.forceProcessTeammates) {
    env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1';
    return;
  }

  delete env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES;
}

export function buildDesktopTeammateModeCliArgs(
  decision: Pick<DesktopTeammateModeDecision, 'injectedTeammateMode'>
): string[] {
  return decision.injectedTeammateMode ? ['--teammate-mode', decision.injectedTeammateMode] : [];
}
