import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** The same private file/digest captured by Desktop and its original Host; no SDK imports. */
export function readCapturedProfile(path: string, sha256: string): unknown {
  if (!isAbsolute(path) || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Invalid host profile');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Invalid host profile');
    const bytes = readFileSync(fd);
    if (bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Invalid host profile');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}
