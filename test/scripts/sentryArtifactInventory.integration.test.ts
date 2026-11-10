// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

it('observes real locked Sentry injection, worker/dynamic inventory and final Vite HTML before writeBundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sentry-inventory-build-'));
  let passed = false;
  try {
    const tsconfig = join(directory, 'tsconfig.json');
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
      })
    );
    const harness = fileURLToPath(
      new URL('../../scripts/build/verifySentryArtifactInventory.ts', import.meta.url)
    );
    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    await promisify(execFile)(process.execPath, ['--import', tsxLoader, harness, directory], {
      cwd: directory,
      // No SENTRY_* vars, env files, real HOME or upload credentials reach the child.
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        USERPROFILE: directory,
        NODE_ENV: 'production',
        TSX_TSCONFIG_PATH: tsconfig,
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    expect(report.uploadDisabled).toBe(true);
    expect(report.rendererBuildTarget).toMatch(/^chrome[0-9]+$/);
    expect(report.observations).toHaveLength(2);
    expect(report.observations[0].artifactFiles).toEqual([
      'dist-electron/main/main.cjs',
      'dist-electron/main/worker.cjs',
    ]);
    expect(report.observations[1].artifactFiles).toHaveLength(2);
    expect(
      report.observations[1].artifactFiles.some((file: string) =>
        /^out\/renderer\/assets\/dynamic-.*\.js$/.test(file)
      )
    ).toBe(true);
    for (const observation of report.observations) {
      expect(observation.hookOrder).toEqual([
        'generateBundle-before-vite-finalizers',
        'generateBundle-before-inventory',
        'writeBundle-after-inventory',
      ]);
      expect(observation.jsUnchanged).toBe(true);
      expect(observation.originalMapsMatched).toBe(true);
      expect(observation.runtime.coverage.preload).toBe('uncovered');
    }
    expect(report.observations[1].viteFinalizerChangedFiles.length).toBeGreaterThan(0);
    passed = true;
  } finally {
    if (passed) await rm(directory, { recursive: true, force: true });
    else console.error(`Synthetic Sentry failure evidence retained at ${directory}`);
  }
}, 75_000);
