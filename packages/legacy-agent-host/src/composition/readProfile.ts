import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { teamHostProfileSchema } from './TeamHost.js';

import type { TeamHostProfile } from './TeamHost.js';

/** Captured private file and digest are supplied by the trusted Desktop profile. */
export function readTeamHostProfile(path: string, sha256: string): TeamHostProfile {
  if (!isAbsolute(path) || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Invalid host profile');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Invalid host profile');
    const bytes = readFileSync(fd);
    if (bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Invalid host profile');
    return teamHostProfileSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally {
    closeSync(fd);
  }
}
