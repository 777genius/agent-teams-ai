/** TEST input staging only; never runs the bundled legacy CLI or changes an installed selection. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { buildProcessNativeArtifact } from '../../packages/legacy-agent-host/scripts/buildProcessNativeArtifact.ts';
import { assertNativeV1Source } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { isQualifiedDarwinBuild } from '../../packages/legacy-agent-host/dist/process/qualifiedDarwinBuild.js';
import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery.ts';
import { verifyExternalOpenCodeV2Base } from '../lib/opencode-v2-base-inventory.mts';
import type { OpenCodeV2DeliveryDescriptor } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery.ts';

const repository = resolve(import.meta.dirname, '../..');
const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const readCommand = (file: string, args: string[]) =>
  execFileSync(file, args, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }).trim();
async function pin(file: string) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 512 * 1024 * 1024);
  assert.equal(await realpath(file), file);
  return { path: file, sha256: await digest(file) };
}

async function prepare() {
  assert.equal(process.version, 'v24.21.0');
  const platform = `${process.platform}-${process.arch}`;
  assert.ok(
    ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(platform)
  );
  assert.equal(platform, process.env.OPENCODE_V2_TEST_PLATFORM);
  const sourceHead = readCommand('git', ['rev-parse', 'HEAD']);
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  assert.equal(sourceHead, process.env.OPENCODE_V2_TEST_SOURCE_HEAD);
  assertNativeV1Source(repository, sourceHead);
  const receiptPath = process.env.OPENCODE_V2_EMBEDDED_INPUTS_RECEIPT!;
  assert.ok(receiptPath && isAbsolute(receiptPath));
  const root = await realpath(
    await mkdtemp(
      join(await realpath(process.env.RUNNER_TEMP ?? tmpdir()), 'TEST-opencode-v2-inputs-')
    )
  );
  const evidence: Record<string, unknown> = {
    kind: 'TEST_NATIVE_V2_EMBEDDED_INPUTS',
    status: 'HOLD',
    sourceHead,
    platform,
    nodeVersion: process.version,
    productQualified: false,
    stage: 'selection',
  };
  await writeFile(receiptPath, JSON.stringify(evidence), { mode: 0o600, flag: 'wx' });
  let failure: { error: unknown } | undefined;
  try {
    const lock = JSON.parse(await readFile(join(repository, 'runtime.lock.json'), 'utf8'));
    const selected = readOpenCodeV2DeliveryMap(lock)?.[platform];
    assert.ok(selected);
    assert.deepEqual(selected.engineVersions, ['2.1.4']);
    assert.equal(
      selected.requiredBunVersion,
      process.platform === 'darwin' ? '1.4.4' : process.platform === 'win32' ? '1.4.3' : '1.3.11'
    );
    assert.match(lock.releaseRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(lock.releaseTag, /^[A-Za-z0-9_.-]+$/);
    // The preceding existing stage-runtime step validates the complete base archive SHA.
    // Recheck its source/Bun inventory before selecting its real Bun; never execute cli.js.
    const base = await realpath(join(repository, 'resources/runtime'));
    assert.equal(verifyExternalOpenCodeV2Base(base, lock, platform), true);
    const bun = await pin(join(base, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun'));
    evidence.baseArchiveSha256 = lock.assets[platform].sha256;
    evidence.runtimeSource = selected.sourceCommit;
    evidence.bun = { ...bun, version: selected.requiredBunVersion };
    const env: Record<string, string> = {
      OPENCODE_V2_EMBEDDED_BUN: bun.path,
      OPENCODE_V2_EMBEDDED_BUN_SHA256: bun.sha256,
      OPENCODE_V2_EMBEDDED_PRODUCT_ADMITTED: '1',
    };
    if (process.platform === 'darwin') {
      const osBuild = readCommand('/usr/sbin/sysctl', ['-n', 'kern.osversion']);
      evidence.osBuild = osBuild;
      const productAdmitted = isQualifiedDarwinBuild(osBuild);
      evidence.productTupleAdmitted = productAdmitted;
      if (!productAdmitted) {
        assert.equal(
          osBuild,
          process.env.OPENCODE_V2_TEST_DARWIN_CANDIDATE_BUILD,
          'candidate compilation requires the exact selected runner build'
        );
        env.OPENCODE_V2_EMBEDDED_PRODUCT_ADMITTED = '0';
        env.OPENCODE_V2_EMBEDDED_DARWIN_CANDIDATE_BUILD = osBuild;
        env.OPENCODE_V2_EMBEDDED_DARWIN_CANDIDATE_ARCH = process.arch;
      }
      evidence.stage = 'native-artifact';
      const node = await realpath(process.execPath);
      const headersRoot = await realpath(join(dirname(dirname(node)), 'include/node'));
      const versionHeader = await readFile(join(headersRoot, 'node_version.h'), 'utf8');
      for (const [name, value] of [
        ['MAJOR', '24'],
        ['MINOR', '21'],
        ['PATCH', '0'],
      ])
        assert.match(
          versionHeader,
          new RegExp(`^#define NODE_${name}_VERSION\\s+${value}\\s*$`, 'm')
        );
      const names = [
        'node_api.h',
        'node_api_types.h',
        'js_native_api.h',
        'js_native_api_types.h',
        'node_version.h',
      ];
      const headers = await Promise.all(
        names.map(async (file) => ({ file, sha256: (await pin(join(headersRoot, file))).sha256 }))
      );
      const compiler = await pin(
        await realpath(readCommand('/usr/bin/xcrun', ['--find', 'clang']))
      );
      const sdkRoot = await realpath(readCommand('/usr/bin/xcrun', ['--show-sdk-path']));
      const sdk = await pin(join(sdkRoot, 'SDKSettings.json'));
      const source = await pin(
        join(repository, 'packages/legacy-agent-host/native/registered-process-darwin.c')
      );
      const artifact = buildProcessNativeArtifact(
        {
          compiler: compiler.path,
          compilerSha256: compiler.sha256,
          sdkRoot,
          sdkSettingsSha256: sdk.sha256,
          headersRoot,
          headers,
          source: source.path,
          sourceSha256: source.sha256,
          outputDirectory: join(root, 'process-artifact'),
        },
        productAdmitted ? undefined : { osBuild, architecture: process.arch as 'arm64' | 'x64' }
      );
      evidence.processArtifact = artifact;
      env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY = artifact.directory;
      env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256 = artifact.manifestSha256;
    }
    evidence.stage = 'support-archive';
    // This app-owned module uses bundler imports; the explicit tsx CI loader
    // resolves them without changing the Host scripts' NodeNext project.
    const support: {
      downloadV2SupportArchive(
        url: string,
        destination: string,
        descriptor: OpenCodeV2DeliveryDescriptor,
        progress: (bytes: number, total: number) => void
      ): Promise<void>;
      extractV2SupportArchive(
        archive: string,
        root: string,
        descriptor: OpenCodeV2DeliveryDescriptor
      ): Promise<void>;
    } = await import(
      new URL(
        '../../src/features/opencode-runtime-installer/main/infrastructure/v2SupportArchive.ts',
        import.meta.url
      ).href
    );
    const archive = join(root, selected.archive.file);
    const url = `https://github.com/${lock.releaseRepository}/releases/download/${lock.releaseTag}/${selected.archive.file}`;
    await support.downloadV2SupportArchive(url, archive, selected, () => {});
    const graph = join(root, 'engine');
    await mkdir(graph, { mode: 0o700 });
    evidence.stage = 'support-extraction';
    await support.extractV2SupportArchive(archive, graph, selected);
    await verifyOpenCodeV2EmbeddedGraph({
      directory: graph,
      manifestSha256: selected.manifest.sha256,
      version: '2.1.4',
      platform: process.platform,
      arch: process.arch,
    });
    evidence.supportArchiveSha256 = selected.archive.sha256;
    evidence.manifestSha256 = selected.manifest.sha256;
    env.OPENCODE_V2_EMBEDDED_GRAPH = graph;
    env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256 = selected.manifest.sha256;
    assertNativeV1Source(repository, sourceHead);
    assert.deepEqual(await pin(bun.path), bun);
    assert.ok(process.env.GITHUB_ENV, 'CI input staging requires the current job environment file');
    for (const value of Object.values(env)) assert.ok(!/[\r\n\0]/.test(value));
    await appendFile(
      process.env.GITHUB_ENV!,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    );
    evidence.status = 'READY';
    evidence.stage = 'prepared';
  } catch (error) {
    failure = { error };
  } finally {
    try {
      await writeFile(receiptPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

await prepare();
