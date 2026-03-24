/**
 * Builds an enriched environment for Claude CLI child processes.
 *
 * Packaged Electron apps on macOS receive a minimal PATH (often just /usr/bin:/bin)
 * and may lack USER (needed for macOS Keychain credential lookup).
 * This helper merges the user's interactive-shell env (cached during startup) with
 * common install locations so that `claude` and its subprocesses (node, npx, etc.)
 * can find the tools they need and authenticate properly.
 */

import { userInfo } from 'os';

import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';

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

  return {
    ...process.env,
    ...(shellEnv ?? {}),
    HOME: home,
    USERPROFILE: home,
    PATH: buildMergedCliPath(binaryPath),
    CLAUDE_CONFIG_DIR: getClaudeBasePath(),
    ...(user
      ? {
          USER: user,
          LOGNAME: shellEnv?.LOGNAME?.trim() || process.env.LOGNAME?.trim() || user,
        }
      : {}),
  };
}
