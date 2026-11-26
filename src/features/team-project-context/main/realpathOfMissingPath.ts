import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type RealpathFn = (value: string) => Promise<string>;

/**
 * Real path of a path that may not exist any more: the deepest existing
 * ancestor is resolved with realpath (so a symlinked parent such as
 * /var -> /private/var maps to the stored key) and the missing tail is
 * appended unchanged. Different missing paths therefore never collapse, and a
 * dangling link is not followed.
 *
 * Only a missing path component (ENOENT/ENOTDIR) is tolerated; any other
 * error propagates. When even the root is missing (an unplugged drive such as
 * E:\ or an unreachable share) nothing can be resolved and the normalized
 * path is returned as it is, which is the lexical key used before ancestors
 * were resolved.
 *
 * `realpath` is a seam for tests; production always uses fs.realpath.
 */
export async function realpathOfMissingPath(
  value: string,
  realpath: RealpathFn = fs.realpath
): Promise<string> {
  const normalized = path.normalize(value);
  const missingTail: string[] = [];
  let current = normalized;
  for (;;) {
    try {
      const real = await realpath(current);
      return missingTail.length > 0 ? path.join(real, ...missingTail) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return normalized;
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}
