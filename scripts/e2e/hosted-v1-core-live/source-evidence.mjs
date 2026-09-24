import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Include untracked, nonignored driver and issuer source as well as tracked build inputs.
// A Git HEAD/diff pair alone cannot identify the files executed by this runner.
export async function captureSourceManifest(repo) {
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  const paths = [...new Set(stdout.toString('utf8').split('\0').filter(Boolean))].sort();
  const files = [];
  for (const path of paths) {
    const absolute = join(repo, path);
    const stat = await lstat(absolute);
    if (stat.isFile()) files.push({ path, type: 'file', sha256: hash(await readFile(absolute)) });
    else if (stat.isSymbolicLink()) {
      files.push({ path, type: 'symlink', sha256: hash(Buffer.from(await readlink(absolute))) });
    } else throw new Error(`core-live-source-entry-not-file:${path}`);
  }
  const canonical = JSON.stringify({ schemaVersion: 1, files });
  return { schemaVersion: 1, fileCount: files.length, sha256: hash(canonical), files };
}
