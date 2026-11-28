/** TEST adapter for the original install selector, with every bundled source bound to HEAD. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NativeInstallMetadata {
  name?: string;
  version?: string;
  dist?: { tarball?: string; integrity?: string };
  optionalDependencies?: Record<string, string>;
  versions?: Record<string, NativeInstallMetadata>;
}
type Selector = {
  (
    generation: 'v1', qualifiedV2Version: null, candidates: readonly { packageName: string }[],
    fetchMetadata: (name: string, version?: string | null) => Promise<NativeInstallMetadata>,
    requestedVersion?: string,
  ): Promise<{ packageName: string; metadata: NativeInstallMetadata & { name: string; version: string }; generation: 'v1' }>;
  (
    generation: 'v2', qualifiedV2Version: '2.1.4', candidates: readonly { packageName: 'opencode-linux-x64' }[],
    fetchMetadata: (name: string, version?: string | null) => Promise<NativeInstallMetadata>,
    requestedVersion?: string,
  ): Promise<{ packageName: string; metadata: NativeInstallMetadata & { name: string; version: string }; generation: 'v2' }>;
};

export async function measureNativeInstallerSources(repo: string, sourceHead: string, sourceInputs: string[]) {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', timeout: 5000,
  }).trim();
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  const inputs = [...new Set([...sourceInputs, 'tsconfig.node.json', 'package.json', 'pnpm-lock.yaml'])].sort();
  for (const input of inputs) assert.ok(resolve(repo, input).startsWith(repo + '/') && !input.includes('node_modules/'));
  const assertClean = () => {
    assert.equal(git(['rev-parse', 'HEAD']), sourceHead);
    git(['ls-files', '--error-unmatch', '--', ...inputs]);
    assert.equal(git(['diff', '--name-only', 'HEAD', '--', ...inputs]), '',
      'original installer and compiler inputs must be clean at the requested HEAD');
  };
  assertClean();
  const measured = await Promise.all(inputs.map(async input => ({
    path: input, sha256: createHash('sha256').update(await readFile(join(repo, input))).digest('hex'),
  })));
  return {
    sourceSha256: createHash('sha256').update(JSON.stringify(measured)).digest('hex'),
    async assertUnchanged() {
      assertClean();
      for (const input of measured)
        assert.equal(createHash('sha256').update(await readFile(join(repo, input.path))).digest('hex'), input.sha256);
    },
  };
}

export async function loadNativeV1InstallSelector(repo: string, sourceHead: string) {
  const require = createRequire(import.meta.url);
  const esbuild = await import(pathToFileURL(createRequire(require.resolve('tsx/package.json')).resolve('esbuild')).href) as {
    build(options: Record<string, unknown>): Promise<{
      outputFiles: { contents: Uint8Array }[];
      metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: unknown[] }> };
      warnings: unknown[];
    }>;
  };
  const compiled = await esbuild.build({
    absWorkingDir: repo,
    entryPoints: ['src/features/opencode-runtime-installer/main/infrastructure/packageSelection.ts'],
    tsconfig: join(repo, 'tsconfig.node.json'), bundle: true, platform: 'node', format: 'esm',
    target: 'node24', metafile: true, write: false, logLevel: 'warning',
  });
  assert.deepEqual(compiled.warnings, []);
  assert.equal(compiled.outputFiles.length, 1);
  assert.ok(Object.values(compiled.metafile.outputs).every(output => output.imports.length === 0),
    'the pure selection bundle must not substitute or load an external implementation');
  const source = await measureNativeInstallerSources(repo, sourceHead, Object.keys(compiled.metafile.inputs));
  const bytes = Buffer.from(compiled.outputFiles[0]!.contents);
  const api = await import('data:text/javascript;base64,' + bytes.toString('base64')) as { selectOpenCodeInstallPackage: Selector };
  assert.equal(typeof api.selectOpenCodeInstallPackage, 'function');
  return {
    select: api.selectOpenCodeInstallPackage,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    ...source,
  };
}
