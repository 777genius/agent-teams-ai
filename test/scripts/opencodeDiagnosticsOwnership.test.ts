import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sandboxes: string[] = [];
afterEach(() =>
  sandboxes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);
const script = path.resolve('scripts/e2e/opencode-diagnostics-desktop.mjs');
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-'));
  sandboxes.push(root);
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ root }));
  return root;
}
function refusal(root: string): string {
  try {
    execFileSync(process.execPath, [script, 'verify', root], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  throw new Error('An unowned profile was accepted');
}
describe.skipIf(process.platform === 'win32')('OpenCode desktop fixture ownership', () => {
  it('refuses seed-only verification before connecting to CDP', () => {
    expect(refusal(sandbox())).toContain('launcher.pid');
  });
  it('refuses an unrelated live process even with a matching birth timestamp', () => {
    const root = sandbox();
    writeFileSync(path.join(root, 'launcher.pid'), String(process.pid));
    writeFileSync(
      path.join(root, 'launcher.birth'),
      execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      })
    );
    expect(refusal(root)).toContain('Launcher identity changed');
  });
});
