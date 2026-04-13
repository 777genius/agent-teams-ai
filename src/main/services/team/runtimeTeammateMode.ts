import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { execFile } from 'child_process';

const TMUX_AVAILABILITY_CACHE_TTL_MS = 10_000;

interface DesktopTeammateModeDecision {
  injectedTeammateMode: 'tmux' | null;
  forceProcessTeammates: boolean;
}

let tmuxAvailabilityCache: { value: boolean; at: number } | null = null;
let tmuxAvailablePromise: Promise<boolean> | null = null;

function execFileAsync(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getExplicitTeammateMode(
  rawExtraCliArgs: string | undefined
): 'auto' | 'tmux' | 'in-process' | null {
  const tokens = parseCliArgs(rawExtraCliArgs);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
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

async function isTmuxAvailable(): Promise<boolean> {
  if (
    tmuxAvailabilityCache &&
    Date.now() - tmuxAvailabilityCache.at < TMUX_AVAILABILITY_CACHE_TTL_MS
  ) {
    return tmuxAvailabilityCache.value;
  }

  if (!tmuxAvailablePromise) {
    tmuxAvailablePromise = execFileAsync('tmux', ['-V'], 3_000)
      .then(() => true)
      .catch(() => false)
      .then((value) => {
        tmuxAvailabilityCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        tmuxAvailablePromise = null;
      });
  }

  return tmuxAvailablePromise;
}

export async function resolveDesktopTeammateModeDecision(
  rawExtraCliArgs: string | undefined
): Promise<DesktopTeammateModeDecision> {
  const explicitMode = getExplicitTeammateMode(rawExtraCliArgs);
  if (explicitMode === 'tmux') {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: true,
    };
  }

  if (explicitMode === 'auto' || explicitMode === 'in-process') {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: false,
    };
  }

  if (process.platform === 'win32') {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: false,
    };
  }

  if (!(await isTmuxAvailable())) {
    return {
      injectedTeammateMode: null,
      forceProcessTeammates: false,
    };
  }

  return {
    injectedTeammateMode: 'tmux',
    forceProcessTeammates: true,
  };
}
