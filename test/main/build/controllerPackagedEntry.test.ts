// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { controllerExternalPaths } from '../../../scripts/electron-builder/controller-external-paths.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { rollup } = createRequire(require.resolve('vite/package.json'))('rollup');

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(file)));
    else result.push(file);
  }
  return result;
}

test('development keeps source resolution and unrelated external modules unchanged', () => {
  expect(controllerExternalPaths('serve', root)).toBeUndefined();
  const paths = controllerExternalPaths('build', root)!;
  expect(paths['node:fs']).toBeUndefined();
  expect(paths['another-controller']).toBeUndefined();
  expect(paths['agent-teams-controller/dist/index.js']).toBeUndefined();
});

test('Rollup production externals load the relocated compiled controller with type stripping disabled', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'TEST-controller-relocation-'));
  try {
    const input = path.join(fixture, 'input');
    const controller = path.join(input, 'agent-teams-controller');
    await cp(path.join(root, 'agent-teams-controller/src'), path.join(controller, 'src'), {
      recursive: true,
    });
    await cp(path.join(root, 'agent-teams-controller/scripts'), path.join(controller, 'scripts'), {
      recursive: true,
    });
    await cp(
      path.join(root, 'agent-teams-controller/package.json'),
      path.join(controller, 'package.json')
    );
    const policy = 'src/features/local-http-auth/main/infrastructure/privateFileAcl.ts';
    await mkdir(path.dirname(path.join(input, policy)), { recursive: true });
    await cp(path.join(root, policy), path.join(input, policy));
    execFileSync(process.execPath, [path.join(controller, 'scripts/build.mjs')], {
      cwd: input,
      timeout: 30_000,
    });
    const compiledFiles = await files(path.join(controller, 'dist'));
    expect(compiledFiles.some((file) => /\.(?:cts|ts)$/.test(file))).toBe(false);
    for (const file of compiledFiles.filter((file) => file.endsWith('.js'))) {
      expect(await readFile(file, 'utf8')).not.toMatch(/require\(\s*['"][^'"]+\.cts['"]/);
    }
    const app = path.join(fixture, 'app');
    const relocated = path.join(app, 'node_modules/agent-teams-controller');
    const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
    const { getNodeModuleFileMatcher, excludedExts } = builderRequire(
      'app-builder-lib/out/fileMatcher.js'
    );
    const { NodeModuleCopyHelper } = builderRequire(
      'app-builder-lib/out/util/NodeModuleCopyHelper.js'
    );
    const packager = {
      appInfo: { type: 'module' },
      debugLogger: { isEnabled: false },
      config: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).build,
      getWorkspaceRoot: async () => input,
    };
    const matcher = getNodeModuleFileMatcher(input, app, (value: string) => value, {}, packager);
    const collector = new NodeModuleCopyHelper(matcher, packager);
    const collected: string[] = await collector.collectNodeModules(
      { dir: controller, name: 'agent-teams-controller' },
      excludedExts.split(',').map((value: string) => '.' + value),
      relocated
    );
    expect(collected).toContain(path.join(controller, 'dist/index.js'));
    for (const file of collected) {
      const destination = path.join(relocated, path.relative(controller, file));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(file, destination);
    }
    const entry = path.join(input, 'entry.mjs');
    await writeFile(
      entry,
      "import controller from 'agent-teams-controller'; export const loaded = typeof controller.createController === 'function' && typeof controller.protocols.buildProcessProtocolText === 'function';\n"
    );
    for (const mode of ['legacy', 'bare', 'absolute', 'node-modules-absolute']) {
      const external =
        mode === 'absolute'
          ? path.join(input, 'agent-teams-controller/src/index.js')
          : mode === 'node-modules-absolute'
            ? path.join(input, 'node_modules/agent-teams-controller/src/index.js')
            : 'agent-teams-controller';
      const bundle = await rollup({
        input: entry,
        plugins: [
          {
            name: 'TEST-external-id',
            resolveId: (id: string) =>
              id === 'agent-teams-controller' ? { id: external, external: true } : null,
          },
        ],
      });
      try {
        const output = await bundle.generate({
          format: 'cjs',
          paths: mode === 'legacy' ? undefined : controllerExternalPaths('build', input),
        });
        const chunk = output.output.find((value: { type: string }) => value.type === 'chunk');
        assert(chunk);
        const file = path.join(app, mode + '.cjs');
        await writeFile(file, chunk.code);
        const result = spawnSync(
          process.execPath,
          [
            '--no-experimental-strip-types',
            '-e',
            `if (!require(${JSON.stringify(file)}).loaded) process.exit(2)`,
          ],
          { cwd: app, encoding: 'utf8', timeout: 10_000 }
        );
        if (mode === 'legacy') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toMatch(/SyntaxError|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(chunk.code).toContain('agent-teams-controller/dist/index.js');
        }
      } finally {
        await bundle.close();
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
