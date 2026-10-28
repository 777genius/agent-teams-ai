// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Workflow {
  on: Record<string, { paths?: string[] }>;
  jobs: Record<
    string,
    {
      'cache-mode'?: string;
      env?: Record<string, string>;
      steps: {
        name?: string;
        run?: string;
        uses?: string;
        with?: { script?: string };
        env?: Record<string, string>;
      }[];
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
    expect(first.uses).toBe('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(first.run).toBeUndefined();
    expect(first.with?.script).toBeTruthy();
    expect(file.env?.ACTIONS_CACHE_MODE).toBeUndefined();
    expect(file.jobs.desktop.env?.ACTIONS_CACHE_MODE).toBeUndefined();
    expect(file.jobs.desktop.steps.every((step) => !step.env?.ACTIONS_CACHE_MODE)).toBe(true);
  });

  it('fails closed before checkout unless the runner reports cache mode none', () => {
    const first = workflow('uap-management-desktop-e2e').jobs.desktop.steps[0];
    // Execute the checked-in literal guard; each service-provided mode is data in its own realm.
    // eslint-disable-next-line sonarjs/code-eval
    const guard = new Script(first.with!.script!);
    for (const mode of [undefined, '', 'read', 'write', 'write-only', 'none']) {
      const execute = () =>
        guard.runInNewContext(
          { process: { env: mode === undefined ? {} : { ACTIONS_CACHE_MODE: mode } } },
          { timeout: 1000 }
        );
      if (mode === 'none') expect(execute).not.toThrow();
      else expect(execute).toThrow('The runner must grant cache-mode none');
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
