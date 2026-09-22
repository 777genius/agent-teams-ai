// @vitest-environment node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
// Load generated files with Node, outside Vite's transformed source graph.
const requireBuiltPackage = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const BUILD_SCRIPT = path.join(
  REPOSITORY_ROOT,
  'scripts/hosted-web/build-owner-anchor-library.mjs'
);
const C_COMPILER = process.env.OWNER_ANCHOR_TEST_CC ?? '/usr/bin/cc';
const BUN = process.env.OWNER_ANCHOR_TEST_BUN_PATH;

interface PayloadRecord {
  readonly path: string;
  readonly bytes: number;
  readonly mode: string;
  readonly sha256: string;
}

interface OwnerAnchorProvenance {
  readonly trust: string;
  readonly runtime: {
    readonly format: string;
    readonly builtins: readonly string[];
    readonly externalDependencies: readonly string[];
  };
  readonly target: {
    readonly os: string;
    readonly arch: string;
    readonly format: string;
    readonly machine: string;
    readonly linkage: string;
    readonly interpreter: string | null;
    readonly applicability: string;
  };
  readonly capability: {
    readonly providerStdioVersion: number;
    readonly providerStdioHash: string;
    readonly nativeSha256: string;
  };
  readonly tools: {
    readonly cCompiler: {
      readonly environment: Readonly<Record<string, string>>;
    };
  };
  readonly sourceInputs: readonly Readonly<{ path: string; sha256: string }>[];
  readonly outputs: readonly PayloadRecord[];
}

async function sha256(filePath: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  await visit(directory);
  return result.sort();
}

describe.skipIf(process.platform !== 'linux')('Owner anchor library production package', () => {
  let sandbox: string;
  let consumerDirectory: string;
  let outputDirectory: string;
  let packageJson: {
    readonly main: string;
    readonly types: string;
    readonly dependencies: Readonly<Record<string, string>>;
  };
  let provenance: OwnerAnchorProvenance;

  beforeAll(async () => {
    expect(path.isAbsolute(C_COMPILER)).toBe(true);
    await access(C_COMPILER);
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'owner-anchor-library-test-'));
    outputDirectory = path.join(sandbox, 'package');
    await execFileAsync(
      process.execPath,
      [BUILD_SCRIPT, '--output', outputDirectory, '--cc', C_COMPILER],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    packageJson = JSON.parse(await readFile(path.join(outputDirectory, 'package.json'), 'utf8'));
    provenance = JSON.parse(
      await readFile(path.join(outputDirectory, 'provenance.json'), 'utf8')
    );
    consumerDirectory = path.join(sandbox, 'consumer');
    const packageScope = path.join(consumerDirectory, 'node_modules/@agent-teams');
    await mkdir(packageScope, { recursive: true });
    await symlink(outputDirectory, path.join(packageScope, 'owner-anchor-library'), 'dir');
  }, 130_000);

  afterAll(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  it('fails closed instead of replacing a colliding output directory', async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [BUILD_SCRIPT, '--output', outputDirectory, '--cc', C_COMPILER],
        {
          cwd: REPOSITORY_ROOT,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        }
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('output-collision') });
  });

  it('emits the real adapter, ownership ports, parsers, materializer, and spawner', async () => {
    const mainUrl = pathToFileURL(path.resolve(outputDirectory, packageJson.main)).href;
    const library = requireBuiltPackage(fileURLToPath(mainUrl));
    expect(library).toMatchObject({
      AnchorProcessSupervisorAdapter: expect.any(Function),
      NodeAnchorLaunchMaterializer: expect.any(Function),
      NodeAnchorSpawner: expect.any(Function),
      NodeAttestedOwningProcess: expect.any(Function),
      parseProcessOwnerBinding: expect.any(Function),
      parseOwnedProcessRef: expect.any(Function),
      parseExecutionUnitId: expect.any(Function),
      parseLaneId: expect.any(Function),
      parseMemberId: expect.any(Function),
      parseRunId: expect.any(Function),
      parseTeamId: expect.any(Function),
      parseWorkspaceId: expect.any(Function),
      createSpawnIntent: expect.any(Function),
    });
    expect(library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION).toBe(1);
    expect(library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH).toBe(
      provenance.capability.providerStdioHash
    );
  });

  it('resolves the package root and native-artifact subpath by package name in Node', async () => {
    const program = `import * as library from '@agent-teams/owner-anchor-library';\nimport { verifyOwnerAnchorNativeArtifact } from '@agent-teams/owner-anchor-library/native-artifact';\nif (typeof library.AnchorProcessSupervisorAdapter !== 'function') throw new Error('adapter-missing');\nawait verifyOwnerAnchorNativeArtifact();`;
    await expect(
      execFileAsync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: consumerDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      })
    ).resolves.toBeDefined();
  });

  it('has a mechanically closed runtime and declaration graph', async () => {
    expect(packageJson.dependencies).toEqual({});
    expect(provenance.runtime).toMatchObject({ format: 'esm', externalDependencies: [] });
    expect(provenance.runtime.builtins.every((value) => value.startsWith('node:'))).toBe(true);
    const modulePattern = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
    const libraryFiles = (await filesBelow(path.join(outputDirectory, 'lib'))).filter((file) =>
      /\.(?:js|d\.ts)$/.test(file)
    );
    expect(libraryFiles.length).toBeGreaterThan(2);
    for (const file of libraryFiles) {
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toContain('@shared/');
      expect(contents).not.toContain('@main/');
      expect(contents).not.toContain('@features/');
      for (const match of contents.matchAll(modulePattern)) {
        expect(match[1].startsWith('.') || match[1].startsWith('node:')).toBe(true);
      }
    }
    expect(
      provenance.sourceInputs.some((input) => input.path.includes('internal-storage'))
    ).toBe(false);
    expect(provenance.sourceInputs.some((input) => input.path.includes('electron'))).toBe(false);
    await access(path.resolve(outputDirectory, packageJson.types));
  });

  it('binds the production source and header to a verified target ELF', async () => {
    const nativePath = path.join(outputDirectory, 'native/process-anchor');
    const nativeBytes = await readFile(nativePath);
    expect(nativeBytes.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(await sha256(nativePath)).toBe(provenance.capability.nativeSha256);
    expect((await stat(nativePath)).mode & 0o222).toBe(0);
    expect(provenance.target).toMatchObject({ os: 'linux', arch: process.arch, format: 'ELF64' });
    expect(provenance.tools.cCompiler.environment).toMatchObject({
      LANG: 'C',
      LC_ALL: 'C',
      SOURCE_DATE_EPOCH: '0',
    });
    expect(provenance.sourceInputs.map((input) => input.path)).toEqual(
      expect.arrayContaining([
        'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c',
        'src/features/team-runtime-control/main/native/process-anchor/process_anchor_protocol.h',
      ])
    );
    const artifactModule = requireBuiltPackage(path.join(outputDirectory, 'native-artifact.js'));
    await expect(artifactModule.verifyOwnerAnchorNativeArtifact()).resolves.toBe(nativePath);
  });

  it('records every payload byte in provenance without asserting admission', async () => {
    expect(provenance.trust).toBe('provenance-only-not-signature-or-admission');
    for (const output of provenance.outputs) {
      const outputPath = path.join(outputDirectory, output.path);
      expect((await stat(outputPath)).size).toBe(output.bytes);
      expect(await sha256(outputPath)).toBe(output.sha256);
    }
    const recorded = new Set(provenance.outputs.map((output) => output.path));
    for (const file of await filesBelow(outputDirectory)) {
      const relative = path.relative(outputDirectory, file).split(path.sep).join('/');
      if (relative === 'provenance.json') continue;
      expect(recorded.has(relative)).toBe(true);
    }
    for (const directory of [
      outputDirectory,
      path.join(outputDirectory, 'lib'),
      path.dirname(path.resolve(outputDirectory, packageJson.main)),
      path.join(outputDirectory, 'native'),
      path.join(outputDirectory, 'native/source'),
    ]) {
      expect((await stat(directory)).mode & 0o555).toBe(0o555);
    }
  });

  it.skipIf(!BUN)('imports and verifies the same package with the pinned Bun 1.4 executable', async () => {
    expect(path.isAbsolute(BUN!)).toBe(true);
    const bunVersion = await execFileAsync(BUN!, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(bunVersion.stdout.trim()).toMatch(/^1\.4\./);
    const program = `const library = await import('@agent-teams/owner-anchor-library');\nconst artifact = await import('@agent-teams/owner-anchor-library/native-artifact');\nif (typeof library.AnchorProcessSupervisorAdapter !== 'function') throw new Error('adapter-missing');\nawait artifact.verifyOwnerAnchorNativeArtifact();`;
    await expect(
      execFileAsync(BUN!, ['-e', program], {
        cwd: consumerDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      })
    ).resolves.toBeDefined();
  });
});
