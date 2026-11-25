import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { realpathOfMissingPath } from '../../../src/features/team-project-context/main/realpathOfMissingPath';

// Pure tests with a fake realpath, so they behave the same on every OS and do
// not need a real symlink, a real drive or a real share.
const root = path.parse(process.cwd()).root;
const existing = path.join(root, 'existing');
const resolvedExisting = path.join(root, 'resolved-existing');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('realpathOfMissingPath', () => {
  it('resolves the deepest existing ancestor and keeps the missing tail in order', async () => {
    const realpath = (value: string): Promise<string> =>
      value === existing ? Promise.resolve(resolvedExisting) : Promise.reject(errno('ENOENT'));
    expect(await realpathOfMissingPath(path.join(existing, 'G', 'W'), realpath))
      .toBe(path.join(resolvedExisting, 'G', 'W'));
    expect(await realpathOfMissingPath(path.join(existing, 'W', 'G'), realpath))
      .toBe(path.join(resolvedExisting, 'W', 'G'));
  });

  it('returns the real path unchanged when nothing is missing', async () => {
    const realpath = (value: string): Promise<string> =>
      Promise.resolve(value === existing ? resolvedExisting : value);
    expect(await realpathOfMissingPath(existing, realpath)).toBe(resolvedExisting);
  });

  it('treats a path below a file (ENOTDIR) like a missing path', async () => {
    const file = path.join(existing, 'file');
    const realpath = (value: string): Promise<string> =>
      value === file
        ? Promise.resolve(path.join(resolvedExisting, 'file'))
        : Promise.reject(errno('ENOTDIR'));
    expect(await realpathOfMissingPath(path.join(file, 'project'), realpath))
      .toBe(path.join(resolvedExisting, 'file', 'project'));
  });

  it('returns the normalized path when even the root is missing (unplugged drive or share)', async () => {
    const realpath = (): Promise<string> => Promise.reject(errno('ENOENT'));
    const missing = path.join(root, 'unplugged-drive', 'proj');
    expect(await realpathOfMissingPath(missing, realpath)).toBe(path.normalize(missing));
    expect(await realpathOfMissingPath(root, realpath)).toBe(path.normalize(root));
  });

  it.each(['EACCES', 'ELOOP', 'EPERM'])('does not swallow %s', async (code) => {
    const realpath = (): Promise<string> => Promise.reject(errno(code));
    await expect(realpathOfMissingPath(path.join(existing, 'project'), realpath))
      .rejects.toMatchObject({ code });
  });
});
