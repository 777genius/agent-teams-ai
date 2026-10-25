// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Workflow {
  on: Record<string, { paths?: string[] }>;
  jobs: Record<
    string,
    {
      'cache-mode'?: string;
      env?: Record<string, string>;
      steps: { name?: string; run?: string; uses?: string; env?: Record<string, string> }[];
    }
  >;
  env?: Record<string, string>;
}
function workflow(name: string): Workflow {
  return parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
  ) as Workflow;
}

describe('UAP desktop workflow trust context', () => {
  it('executes cross-repository code only on PRs with server-scoped cache authority disabled', () => {
    const file = workflow('uap-management-desktop-e2e');
    expect(Object.keys(file.on)).toEqual(['pull_request']);
    expect(file.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        '.github/workflows/uap-management-desktop-e2e.yml',
        'scripts/e2e/uap-management-*.ts',
        'src/features/extension-management/**',
        'vendor/uap/sdk/**',
      ])
    );
    expect(file.jobs.desktop['cache-mode']).toBe('none');
    const first = file.jobs.desktop.steps[0];
    expect(first.uses).toBeUndefined();
    expect(first.run).toBeTruthy();
    expect(file.env?.ACTIONS_CACHE_MODE).toBeUndefined();
    expect(file.jobs.desktop.env?.ACTIONS_CACHE_MODE).toBeUndefined();
    expect(file.jobs.desktop.steps.every((step) => !step.env?.ACTIONS_CACHE_MODE)).toBe(true);
  });

  it('fails closed before checkout unless the runner reports cache mode none', () => {
    const first = workflow('uap-management-desktop-e2e').jobs.desktop.steps[0];
    for (const mode of [undefined, '', 'read', 'write', 'write-only', 'none']) {
      const result = spawnSync('bash', ['-eu', '-c', first.run!], {
        env: mode === undefined ? {} : { ACTIONS_CACHE_MODE: mode },
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0, `cache authority ${String(mode)}`).toBe(mode === 'none');
    }
  });

  it('retains Actions and JavaScript scans for the changed workflow and harness', () => {
    const codeql = workflow('codeql');
    for (const event of ['push', 'pull_request']) {
      expect(codeql.on[event].paths).toEqual(
        expect.arrayContaining(['.github/workflows/**', 'scripts/**'])
      );
    }
  });
});
