import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';

/** Read-only canonicalization. Navigation may address a missing folder; launch/admission may not. */
export function hostProjectPathIdentity(raw: string, requireDirectory = false): { key: string; path: string } {
  if (!raw.trim() || raw !== raw.trim() || !isAbsolute(raw) || /[\0\r\n]/u.test(raw)) throw new TeamOwnerError('invalid');
  let path = resolve(raw);
  try {
    path = realpathSync.native(path);
    if (requireDirectory && !statSync(path).isDirectory()) throw new TeamOwnerError('invalid');
  } catch (error) {
    if (requireDirectory || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { path, key: digest(process.platform === 'win32' ? path.toLowerCase() : path) };
}
