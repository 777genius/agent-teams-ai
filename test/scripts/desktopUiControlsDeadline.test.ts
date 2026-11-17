// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the complete original UI deadline regressions without skips', () => {
  const path = fileURLToPath(new URL(
    '../../scripts/legacy-agent-host/desktop-ui-controls-deadline.test.ts', import.meta.url
  ));
  // The existing workspace suite selects this entry. Run the original Node
  // cases in their own process so their Date mocks cannot affect Vitest.
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const diagnostic = result.stdout + result.stderr;
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.signal, diagnostic).toBeNull();
  expect(result.status, diagnostic).toBe(0);
  for (const [key, count] of [['tests', 10], ['pass', 10], ['fail', 0],
    ['cancelled', 0], ['skipped', 0], ['todo', 0]] as const) {
    expect(result.stdout).toMatch(new RegExp('^# ' + key + ' ' + count + '\\r?$', 'm'));
  }
}, 20_000);
