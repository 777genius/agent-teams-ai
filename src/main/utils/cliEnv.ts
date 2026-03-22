/**
 * Builds an enriched environment for Claude CLI child processes.
 *
 * Packaged Electron apps on macOS receive a minimal PATH (often just /usr/bin:/bin).
 * This helper merges the user's interactive-shell env (cached during startup) with
 * common install locations so that `claude` and its subprocesses (node, npx, etc.)
 * can find the tools they need.
 */

import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';

export function buildEnrichedEnv(binaryPath?: string | null): NodeJS.ProcessEnv {
  const home = getShellPreferredHome();
  return {
    ...process.env,
    ...(getCachedShellEnv() ?? {}),
    HOME: home,
    USERPROFILE: home,
    PATH: buildMergedCliPath(binaryPath),
  };
}
