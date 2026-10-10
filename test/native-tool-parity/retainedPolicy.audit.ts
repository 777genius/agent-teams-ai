import { beforeAll, describe, expect, it } from 'vitest';

import cases from '../fixtures/native-tool-parity/lint-cases.json';

import { bad, captureEslintPolicy, configs, good, messages, prepareSandbox, run } from './nativeToolParity.harness';

import type { LintResult } from './nativeToolParity.harness';

beforeAll(() => { prepareSandbox(); captureEslintPolicy(); }, 120_000);

describe('retained installed ESLint policy', () => {
  for (const row of cases) {
    it(row.name, () => {
      expect(messages(bad, row.path).filter((d) => d.ruleId === row.rule))
        .toEqual(expect.arrayContaining([expect.objectContaining({ severity: row.severity })]));
      expect(messages(good, row.path).filter((d) => d.ruleId === row.rule)).toEqual([]);
    });
  }
  it('full and fast scopes retain typed/test/feature accessibility differences', () => {
    const full = configs.get('eslint.config.js:src/main/parity/var.ts')!;
    const fast = configs.get('eslint.fast.config.js:src/main/parity/var.ts')!;
    expect(full.languageOptions.parserOptions.projectService).toBe(true);
    expect(fast.languageOptions.parserOptions.projectService).toBe(false);
    expect(full.rules['@typescript-eslint/no-floating-promises'][0]).toBe(1);
    expect(fast.rules['@typescript-eslint/no-floating-promises']).toBeUndefined();
    expect(configs.get('eslint.config.js:test/parity.test.ts')!.rules['@typescript-eslint/no-floating-promises'][0]).toBe(0);
    expect(configs.get('eslint.config.js:src/features/parity/renderer/ui/Store.tsx')!.rules['react/jsx-key']).toBeUndefined();
    expect(configs.get('eslint.fast.config.js:src/features/parity/renderer/ui/Store.tsx')!.rules['react/jsx-key'][0]).toBe(2);
    expect(configs.get('eslint.config.js:src/features/external-agent-connection/renderer/ExternalAgentPromptDialog.tsx')!.rules['jsx-a11y/no-noninteractive-element-interactions'][0]).toBe(2);
  });
  it('floating promises actually remain exempt in tests', () => {
    const result = run('eslint', ['--format', 'json', 'test/parity.test.ts']);
    expect(result.status).toBe(0);
    expect(messages(JSON.parse(result.stdout) as LintResult[], 'test/parity.test.ts')).toEqual([]);
  });
});
