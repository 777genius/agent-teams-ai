import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { prMonitorBoundaries } from '../../../eslint.pr-monitor-boundaries.mts';

// JavaScript import fixtures exercise the actual guard without loading a TS compiler.
const lint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    ...prMonitorBoundaries,
  ],
});

describe('PR Monitor feature architecture guards', () => {
  it.each([
    ['renderer/ui/probe.tsx', '@renderer/api'],
    ['renderer/ui/probe.tsx', '@renderer/store/slices'],
    ['preload/probe.ts', '@features/pr-monitor/main'],
    ['core/application/probe.ts', 'react-dom/client'],
    ['core/application/probe.ts', '../../main/infrastructure/ghTransport'],
  ])('rejects runtime access from %s to %s', async (file, source) => {
    const [result] = await lint.lintText(`import '${source}';`, {
      filePath: `src/features/pr-monitor/${file}`,
    });
    expect(result.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(
      true
    );
  });

  it.each([
    ['src/main/probe.ts', '@features/pr-monitor/core/application/projectMonitor'],
    ['src/main/probe.ts', '../features/pr-monitor/main/infrastructure/ghTransport'],
    ['src/features/pr-monitor/main/probe.ts', '@features/gateway-provider/core/application/port'],
    ['src/features/pr-monitor/main/probe.ts', '@features/review-flow/core/application/port'],
  ])('requires public entrypoints from %s to %s', async (filePath, source) => {
    const [result] = await lint.lintText(`import '${source}';`, { filePath });
    expect(result.messages.some((message) => message.ruleId === 'import/no-internal-modules')).toBe(
      true
    );
  });

  it('allows the shell to compose a public feature entrypoint', async () => {
    const [result] = await lint.lintText("import '@features/pr-monitor/main';", {
      filePath: 'src/main/probe.ts',
    });
    expect(result.messages).toEqual([]);
  });
  it('allows pure public SDK models in renderer presentation', async () => {
    const [result] = await lint.lintText("import '@pr-monitor/core';", {
      filePath: 'src/features/pr-monitor/renderer/ui/probe.tsx',
    });
    expect(result.messages).toEqual([]);
  });
});
