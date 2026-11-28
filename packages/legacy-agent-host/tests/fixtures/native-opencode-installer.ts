/** Runs the original installer in actual Electron main, without a renderer or substitute ports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CapturedProcess } from '../../dist/adapters/providers/CapturedProcess.js';
import { fileHash } from './native-host.ts';
import { measureNativeInstallerSources } from './native-opencode-install-selection.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const entrySource = `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const inputPath = process.env.TEST_OPENCODE_INSTALLER_INPUT;
let request;
app.whenReady().then(async () => {
  request = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.versions.electron, request.electronVersion);
  for (const key of ['CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_BIN_PATH', 'OPENCODE_CLI_PATH'])
    assert.equal(process.env[key], undefined, 'managed installation has no CLI override');
  app.setPath('userData', request.userData);
  const original = await import('./implementation.mjs');
  original.setAppDataBasePath(request.userData);
  const service = new original.OpenCodeRuntimeInstallerService();
  const project = (value) => ({ installed: value.installed, source: value.source, state: value.state,
    version: value.version, binaryPath: value.binaryPath });
  const before = project(await service.getReadinessStatus());
  assert.deepEqual(before, { installed: true, source: 'app-managed', state: 'ready',
    version: request.oldVersion, binaryPath: request.oldBinary });
  const manifestPath = path.join(request.userData, 'data/runtimes/opencode/current.json');
  const manifestBefore = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(request.operation === 'probe' || request.operation === 'install');
  const after = request.operation === 'install'
    ? project(await service.install({ generation: 'v1' })) : before;
  assert.equal(after.installed, true); assert.equal(after.source, 'app-managed');
  assert.equal(after.state, 'ready'); assert.match(after.version, /^1\\.\\d+\\.\\d+$/);
  if (request.operation === 'install') assert.notEqual(after.version, before.version);
  const manifestAfter = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(request.receipt, JSON.stringify({ kind: 'TEST_ORIGINAL_OPENCODE_INSTALLER',
    operation: request.operation, before, after, manifestBefore, manifestAfter,
    electronVersion: process.versions.electron }), { mode: 0o600, flag: 'wx' });
  app.quit();
}).catch(error => {
  console.error('TEST original installer failed: ' + String(error?.message ?? error).slice(0, 512));
  app.exit(1);
});
`;

export async function prepareNativeOpenCodeInstaller(input: {
  repo: string; sourceHead: string; root: string; node: string;
  environment: Record<string, string>; oldBinary: string; oldVersion: string;
}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  assert.equal(await realpath(input.root), input.root);
  for (const key of ['CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_BIN_PATH', 'OPENCODE_CLI_PATH'])
    assert.equal(input.environment[key], undefined);
  const require = createRequire(import.meta.url);
  const installed = record(JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8')));
  const yaml = require('yaml') as { parse(value: string): unknown };
  const lock = record(yaml.parse(await readFile(join(input.repo, 'pnpm-lock.yaml'), 'utf8')));
  const selected = record(record(record(record(lock.importers)['.']).devDependencies).electron);
  assert.equal(installed.name, 'electron');
  assert.equal(installed.version, String(selected.version).split('(')[0], 'actual Electron comes from the frozen lock');
  const electronVersion = String(installed.version);
  const electron = await realpath(join(dirname(require.resolve('electron/package.json')), 'dist/electron'));
  const electronSha256 = await fileHash(electron);
  const directory = await realpath(await mkdtemp(join(input.repo, 'node_modules/.TEST-native-v1-installer-')));
  const userData = join(input.root, 'userData');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  try {
    const esbuild = await import(pathToFileURL(createRequire(require.resolve('tsx/package.json')).resolve('esbuild')).href) as {
      build(options: Record<string, unknown>): Promise<{
        metafile: { inputs: Record<string, unknown> }; warnings: unknown[];
      }>;
    };
    const implementation = join(directory, 'implementation.mjs');
    const generatedEntry = 'TEST-native-opencode-installer-exports.ts';
    const compiled = await esbuild.build({ absWorkingDir: input.repo,
      stdin: { contents: `export { OpenCodeRuntimeInstallerService } from './src/main/services/infrastructure/OpenCodeRuntimeInstallerService.ts';
export { setAppDataBasePath } from './src/main/utils/pathDecoder.ts';`,
        resolveDir: input.repo, sourcefile: generatedEntry, loader: 'ts' },
      bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import { createRequire as TESTCreateRequire } from 'node:module'; const require = TESTCreateRequire(import.meta.url);" },
      tsconfig: join(input.repo, 'tsconfig.node.json'), metafile: true, outfile: implementation,
      logLevel: 'warning',
    });
    assert.deepEqual(compiled.warnings, []);
    const sources = Object.keys(compiled.metafile.inputs).filter(path => path !== generatedEntry);
    assert.equal(sources.length + 1, Object.keys(compiled.metafile.inputs).length);
    sources.push('packages/legacy-agent-host/tests/fixtures/native-opencode-installer.ts');
    const source = await measureNativeInstallerSources(input.repo, input.sourceHead, sources);
    const entry = join(directory, 'main.cjs');
    await writeFile(entry, entrySource, { mode: 0o600, flag: 'wx' });
    const implementationSha256 = await fileHash(implementation);
    const entrySha256 = await fileHash(entry);
    const bundleSha256 = createHash('sha256').update(entrySha256 + '\0' + implementationSha256).digest('hex');
    const processes: { exitCode: number | null; signalCode: string | null; cleanup: boolean }[] = [];
    const assertUnchanged = async () => {
      await source.assertUnchanged();
      assert.equal(await fileHash(electron), electronSha256);
      assert.equal(await fileHash(implementation), implementationSha256);
      assert.equal(await fileHash(entry), entrySha256);
    };
    return {
      userData, bundleSha256, sourceSha256: source.sourceSha256, electronVersion, electronSha256, processes,
      assertUnchanged,
      async run(operation: 'probe' | 'install'): Promise<Record<string, unknown>> {
        await assertUnchanged();
        const requestRoot = await mkdtemp(join(input.root, 'tmp/TEST-installer-request-'));
        const requestPath = join(requestRoot, 'input.json'), receipt = join(requestRoot, 'receipt.json');
        await writeFile(requestPath, JSON.stringify({ operation, receipt, userData, electronVersion,
          oldVersion: input.oldVersion, oldBinary: input.oldBinary }), { mode: 0o600, flag: 'wx' });
        const capture = new CapturedProcess({ provider: 'opencode', cwd: input.root,
          executable: { path: electron, sha256: electronSha256 }, environment: {
            ...input.environment, PATH: dirname(input.node) + ':/usr/bin:/bin',
            TEST_OPENCODE_INSTALLER_INPUT: requestPath,
          } });
        const child = capture.launch({ command: electron, cwd: input.root,
          args: ['--no-sandbox', '--disable-gpu', '--headless', '--ozone-platform=headless',
            '--user-data-dir=' + userData, entry] });
        child.stdin.end();
        let diagnostics = '', primary: unknown, failed = false, timer: NodeJS.Timeout | undefined;
        const cleanupErrors: unknown[] = [];
        const retain = (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-16 * 1024); };
        child.stdout.on('data', retain); child.stderr.on('data', retain);
        try {
          await new Promise<void>((done, reject) => {
            timer = setTimeout(() => reject(new Error('Original Electron installer exceeded the finite TEST deadline')), 180_000);
            child.once('exit', () => done()); child.once('error', reject);
          });
          assert.equal(child.exitCode, 0, diagnostics);
          assert.equal(child.signalCode, null);
        } catch (error) { failed = true; primary = error; }
        finally {
          clearTimeout(timer);
          let cleanup = false;
          try {
            cleanup = await capture.confirmStopped();
          } catch (error) { cleanupErrors.push(error); }
          processes.push({ exitCode: child.exitCode, signalCode: child.signalCode, cleanup });
          if (!cleanup) cleanupErrors.push(new Error('Original Electron installer cleanup is unconfirmed'));
          try { await writeFile(join(requestRoot, 'diagnostic.log'), diagnostics, { mode: 0o600 }); }
          catch (error) { cleanupErrors.push(error); }
        }
        if (failed && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'Original installer and cleanup failed');
        if (failed) throw primary;
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Original installer cleanup failed');
        await assertUnchanged();
        const bytes = await readFile(receipt);
        assert.ok(bytes.byteLength <= 16 * 1024);
        const result = record(JSON.parse(bytes.toString()));
        assert.equal(result.kind, 'TEST_ORIGINAL_OPENCODE_INSTALLER');
        assert.equal(result.operation, operation);
        assert.equal(result.electronVersion, electronVersion);
        return result;
      },
      async close() {
        assert.ok(processes.every(process => process.cleanup), 'retain TEST evidence after unknown process cleanup');
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
