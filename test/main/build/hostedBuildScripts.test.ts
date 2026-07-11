import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageJson {
  knip?: {
    entry?: string[];
  };
  scripts: Record<string, string>;
}

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')
) as PackageJson;
const webViteConfig = readFileSync(resolve(process.cwd(), 'vite.web.config.ts'), 'utf-8');

describe('hosted build scripts', () => {
  it('adds hosted build entrypoints without replacing desktop or standalone runtime scripts', () => {
    expect(packageJson.scripts.build).toContain('electron-vite');
    expect(packageJson.scripts.dev).toBe('node ./scripts/dev-with-runtime.mjs');

    expect(packageJson.scripts.standalone).toBe('tsx src/main/standalone.ts');
    expect(packageJson.scripts['standalone:build']).toContain('docker/vite.standalone.config.ts');
    expect(packageJson.scripts['standalone:start']).toBe('node dist-standalone/index.cjs');
  });

  it('uses a non-Electron hosted shell build path', () => {
    expect(packageJson.scripts['hosted:build']).toBe(
      'pnpm hosted:build:renderer && pnpm hosted:build:server'
    );
    expect(packageJson.scripts['hosted:build:renderer']).toContain('--config vite.web.config.ts');
    expect(packageJson.scripts['hosted:build:server']).toContain(
      '--config docker/vite.hosted-server.config.ts'
    );
    expect(packageJson.scripts['hosted:build']).not.toContain('electron-vite');
    expect(packageJson.scripts['hosted:start']).toBe('node dist-hosted/server.cjs');
  });

  it('builds hosted renderer assets where the Docker image serves them from', () => {
    expect(webViteConfig).toContain("outDir: resolve(ROOT, 'out/renderer')");
    expect(webViteConfig).toContain("target: 'esnext'");
  });

  it('registers hosted and standalone entrypoints for dead-code checks', () => {
    expect(packageJson.knip?.entry).toEqual(
      expect.arrayContaining([
        'src/main/standalone.ts',
        'src/hosted/server.ts',
        'vite.web.config.ts',
        'docker/vite.standalone.config.ts',
        'docker/vite.hosted-server.config.ts',
      ])
    );
  });
});
