/**
 * Builds an enriched environment for Claude CLI child processes.
 *
 * Packaged Electron apps on macOS receive a minimal PATH (often just /usr/bin:/bin)
 * and may lack USER (needed for macOS Keychain credential lookup).
 * This helper merges the user's interactive-shell env (cached during startup) with
 * common install locations so that `claude` and its subprocesses (node, npx, etc.)
 * can find the tools they need and authenticate properly.
 */

import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getAutoDetectedClaudeBasePath, getClaudeBasePath } from '@main/utils/pathDecoder';
import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';
import { userInfo } from 'os';

export function buildEnrichedEnv(binaryPath?: string | null): NodeJS.ProcessEnv {
  const shellEnv = getCachedShellEnv();
  const home = getShellPreferredHome();
  let osUsername = '';
  try {
    osUsername = userInfo().username;
  } catch {
    // userInfo() can throw in restricted environments (Docker, no passwd entry)
  }
  const user =
    shellEnv?.USER?.trim() ||
    process.env.USER?.trim() ||
    process.env.USERNAME?.trim() ||
    osUsername ||
    '';

  // Only set CLAUDE_CONFIG_DIR when the user has configured a custom path.
  // Setting it to the default ~/.claude changes the macOS Keychain namespace
  // that the CLI uses for OAuth credential lookup, causing "not logged in"
  // even though `claude auth login` succeeded without the env var.
  const configDir = getClaudeBasePath();
  const isCustomConfigDir = configDir !== getAutoDetectedClaudeBasePath();

  return {
    ...process.env,
    ...(shellEnv ?? {}),
    HOME: home,
    USERPROFILE: home,
    PATH: buildMergedCliPath(binaryPath),
    ...(isCustomConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    ...(user
      ? {
          USER: user,
          LOGNAME: shellEnv?.LOGNAME?.trim() || process.env.LOGNAME?.trim() || user,
        }
      : {}),
  };
}
