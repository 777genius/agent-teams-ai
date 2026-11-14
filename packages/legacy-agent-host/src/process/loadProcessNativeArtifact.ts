import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

/** One private loader shared by OS adapters; no search path, ambient override or runtime compilation. */
export function loadProcessNativeArtifact<T>(artifact: { path: string; sha256: string }) {
  const hold = (): never => { throw new Error('Registered process custody unavailable'); };
  const { path, sha256 } = artifact;
  if (!/^[a-f0-9]{64}$/.test(sha256) || !path.endsWith('.node')) hold();
  const selected = lstatSync(path);
  const assertBinary = () => {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        realpathSync(path) !== path || info.dev !== selected.dev ||
        info.ino !== selected.ino || info.size !== selected.size ||
        info.mtimeMs !== selected.mtimeMs || info.ctimeMs !== selected.ctimeMs ||
        createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) hold();
  };
  assertBinary();
  const require = createRequire(import.meta.url);
  if (require.cache[path]) return hold();
  const native = require(path) as T;
  assertBinary();
  return { native, assertBinary };
}
