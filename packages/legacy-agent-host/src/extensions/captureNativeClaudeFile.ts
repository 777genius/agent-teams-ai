import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { ManagementCommandError } from '../management/commandRecords.js';

import type { ClaudeManagementProfile } from '../management/profile.js';

function stat(path: string) {
  try {
    const value = lstatSync(path);
    if (
      value.isSymbolicLink() ||
      (!value.isFile() && !value.isDirectory()) ||
      (value.isFile() && value.nlink !== 1)
    )
      throw new ManagementCommandError('held');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Pinned CLI2.1.305 (SDK0.3.305) global-file choice; never infer it from runtime MCP snapshot source or process.env. */
export function captureNativeClaudeFile(
  profile: ClaudeManagementProfile,
  assertOriginal: () => void
) {
  const environment = { ...profile.environment };
  const config = environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME!, '.claude');
  const suffix = environment.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  const current = join(environment.CLAUDE_CONFIG_DIR ?? environment.HOME!, `.claude${suffix}.json`);
  const legacy = join(config, '.config.json');
  const select = () => {
    assertOriginal();
    const old = stat(legacy),
      next = stat(current);
    if (next && !next.isFile()) throw new ManagementCommandError('held');
    return old?.isFile() && (old.size > 0 || ((old.mode & 0o222) !== 0 && !next))
      ? legacy
      : current;
  };
  const path = select();
  return Object.freeze({
    path,
    assertCurrent() {
      if (select() !== path) throw new ManagementCommandError('conflict');
    },
  });
}
