import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = join(
  process.cwd(),
  'scripts/hosted-web/phase-10/state-compatibility/verify-state-compatibility.mjs'
);

function runVerifier(...arguments_: string[]) {
  const execution = spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return {
    status: execution.status,
    stderr: execution.stderr,
    result: JSON.parse(execution.stdout),
  };
}

describe('state compatibility fixture verifier', () => {
  it('is executable and verifies all deterministic fixtures', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);

    const execution = runVerifier();

    expect(execution.status).toBe(0);
    expect(execution.stderr).toBe('');
    expect(execution.result).toMatchObject({
      format: 'hosted-state-compatibility-verifier-result/v1',
      status: 'passed',
      fixtureDirectory: 'test/fixtures/hosted-state-compatibility',
      summary: { total: 6, passed: 6, failed: 0 },
    });
  });

  it('produces byte-stable JSON for the same fixture set', () => {
    const first = runVerifier();
    const second = runVerifier();

    expect(first.result).toEqual(second.result);
  });

  it('uses exit code 2 and a machine-readable result for a missing fixture directory', () => {
    const execution = runVerifier('--fixture-dir', '/definitely/missing/hosted-state-fixtures');

    expect(execution.status).toBe(2);
    expect(execution.stderr).toBe('');
    expect(execution.result).toMatchObject({
      status: 'error',
      error: { code: 'fixture_load_failed' },
      summary: { total: 0, passed: 0, failed: 0 },
    });
  });

  it('uses exit code 2 for invalid arguments', () => {
    const execution = runVerifier('--unknown');

    expect(execution.status).toBe(2);
    expect(execution.result).toMatchObject({
      status: 'error',
      error: { code: 'invalid_arguments' },
    });
  });
});
