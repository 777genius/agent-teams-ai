import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let cached: boolean | null = null;

/**
 * Windows only allows symlink creation for elevated processes or with
 * Developer Mode enabled; tests that model symlink attacks/escapes are skipped
 * where the platform cannot create one at all.
 */
export function canCreateSymlinks(): boolean {
  if (cached !== null) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    cached = true;
  } catch {
    cached = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

export const symlinkTestSkipReason = 'symlink creation is not permitted on this machine';
