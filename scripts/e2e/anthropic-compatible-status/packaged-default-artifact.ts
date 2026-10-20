import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// @ts-expect-error Existing shared JavaScript packaged harness has no declarations.
import { fingerprint, packagedArtifact } from '../opencode-diagnostics/packaged.mjs';
// @ts-expect-error Existing shared JavaScript archive extractor has no declarations.
import { extractArchive } from '../../lib/runtime-payload-cache.mjs';

export interface Fingerprint {
  path: string;
  sha256: string;
}
export interface DefaultArtifact {
  app: Fingerprint;
  archive: Fingerprint;
  orchestrator: Fingerprint;
  renderer: string;
  rendererArtifact: Fingerprint;
}
interface Asset {
  file: string;
  archiveKind: string;
  binaryName: string;
  sha256: string;
}
export interface RuntimeLock {
  version: string;
  cliVersion: string;
  sourceRef: string;
  sourceRepository: string;
  releaseRepository: string;
  releaseTag: string;
  assets: Record<string, Asset>;
}

export async function defaultArtifact(executable: string): Promise<DefaultArtifact> {
  assert(path.isAbsolute(executable), 'Absolute unpacked executable required');
  assert(
    ['win32', 'linux'].includes(process.platform),
    'This qualification supports Windows or Linux'
  );
  if (process.platform === 'win32') {
    assert(/\.exe$/i.test(executable) && !/(setup|uninstall)/i.test(path.basename(executable)));
    return packagedArtifact(executable) as Promise<DefaultArtifact>;
  }
  const app = (await fingerprint(executable)) as Fingerprint;
  const resources = path.join(path.dirname(app.path), 'resources');
  return {
    app,
    archive: await fingerprint(path.join(resources, 'app.asar')),
    orchestrator: await fingerprint(path.join(resources, 'runtime/claude-multimodel')),
    renderer: path.join(resources, 'app.asar/out/renderer/index.html'),
    rendererArtifact: await fingerprint(
      path.join(resources, 'app.asar.unpacked/out/renderer/index.html')
    ),
  };
}

async function inventory(directory: string, relative = ''): Promise<[string, string][]> {
  const result: [string, string][] = [];
  for (const name of (await readdir(path.join(directory, relative))).sort()) {
    const key = relative ? `${relative}/${name}` : name;
    const file = path.join(directory, key);
    const info = await lstat(file);
    if (info.isDirectory()) result.push(...(await inventory(directory, key)));
    else {
      assert(info.isFile(), `Non-regular runtime payload entry: ${key}`);
      const resolved = await realpath(file);
      const root = await realpath(directory);
      assert(!path.relative(root, resolved).startsWith('..'), 'Runtime payload escaped its root');
      result.push([key, ((await fingerprint(file)) as Fingerprint).sha256]);
    }
  }
  return result;
}

/** Public manifest + locked archive -> exact physical files inside the package. */
export async function qualifyDefaultArtifact(
  artifact: DefaultArtifact,
  archive: string,
  root: string,
  repoRoot: string
) {
  const lock = JSON.parse(
    await readFile(path.join(repoRoot, 'runtime.lock.json'), 'utf8')
  ) as RuntimeLock;
  const platform = `${process.platform}-${process.arch}`;
  const asset = lock.assets[platform];
  assert(asset, `No pinned archive for ${platform}`);
  assert.equal(path.basename(archive), asset.file);
  const archiveIdentity = (await fingerprint(archive)) as Fingerprint;
  assert.equal(
    archiveIdentity.sha256,
    asset.sha256,
    'Downloaded archive differs from reviewed lock'
  );
  const manifestName = `agent-teams-runtime-manifest-v${lock.version}.json`;
  const response = await fetch(
    `https://github.com/${lock.releaseRepository}/releases/download/${lock.releaseTag}/${manifestName}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  assert(response.ok, 'Final runtime manifest must be anonymously public');
  const manifestText = await response.text();
  const manifest = JSON.parse(manifestText) as {
    version: string;
    targetReleaseTag: string;
    sourceRepository: string;
    sourceRef: string;
    sourceCommit: string;
    assets: RuntimeLock['assets'];
  };
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.targetReleaseTag, lock.releaseTag);
  assert.equal(manifest.sourceRepository, lock.sourceRepository);
  assert.equal(manifest.sourceRef, lock.sourceRef);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(manifest.assets, lock.assets, 'All final public manifest asset pins must match');
  // Mirror the production resources/runtime layout so the exact afterPack
  // pruning policy can inspect verified source payloads before any omission.
  const sourceAppRoot = path.join(root, 'verified-public-archive');
  const extracted = path.join(sourceAppRoot, 'resources');
  await mkdir(extracted, { recursive: true });
  extractArchive(
    archive,
    extracted,
    asset.archiveKind,
    (command: string, args: string[], options: Record<string, unknown> = {}) => {
      execFileSync(command, args, { timeout: 60_000, ...options });
    }
  );
  const originalRoot = path.join(extracted, 'runtime');
  const runtimeRoot = path.dirname(artifact.orchestrator.path);
  const original = await inventory(originalRoot);
  const bundled = new Map(await inventory(runtimeRoot));
  const { getKnownPrunableNativeArtifactRoot, detectBinaryMetadata, isBinaryCompatible } = (
    createRequire(import.meta.url)('../../electron-builder/afterPack.cjs') as {
      _internal: {
        getKnownPrunableNativeArtifactRoot: (
          root: string,
          file: string,
          platform: string,
          arch: string
        ) => Promise<string | null>;
        detectBinaryMetadata: (file: string) => Promise<{ format: string; archs: string[] } | null>;
        isBinaryCompatible: (
          format: string,
          archs: string[],
          platform: string,
          arch: string
        ) => boolean;
      };
    }
  )._internal;
  const allowedPruned = new Set<string>();
  for (const [file] of original) {
    const physical = path.join(originalRoot, file);
    const prune = await getKnownPrunableNativeArtifactRoot(
      sourceAppRoot,
      physical,
      process.platform,
      process.arch
    );
    if (!prune) continue;
    const metadata = await detectBinaryMetadata(physical);
    if (
      metadata &&
      !isBinaryCompatible(metadata.format, metadata.archs, process.platform, process.arch)
    )
      allowedPruned.add(path.relative(originalRoot, prune).split(path.sep).join('/'));
  }
  const allowedPrunedRoots = [...allowedPruned].sort();
  const actualPrunedFiles: string[] = [];
  for (const [file, digest] of original) {
    if (
      !bundled.has(file) &&
      allowedPrunedRoots.some((prune) => file === prune || file.startsWith(prune + '/'))
    ) {
      actualPrunedFiles.push(file);
      continue;
    }
    assert.equal(
      bundled.get(file),
      digest,
      `Packaged runtime differs from final public archive: ${file}`
    );
  }
  assert.equal((await readFile(path.join(runtimeRoot, 'VERSION'), 'utf8')).trim(), lock.version);
  assert.equal(
    (await readFile(path.join(runtimeRoot, 'COMMIT_SHA'), 'utf8')).trim(),
    manifest.sourceCommit
  );
  const entry = (await fingerprint(path.join(runtimeRoot, 'local-cli/cli.js'))) as Fingerprint;
  const bun = (await fingerprint(
    path.join(runtimeRoot, process.platform === 'win32' ? 'bun/bun.exe' : 'bun/bun')
  )) as Fingerprint;
  return {
    lock,
    manifest,
    manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
    archive: archiveIdentity,
    sourceCommit: manifest.sourceCommit,
    entry,
    bun,
    runtimeRoot,
    publicPayloadFiles: original.length,
    allowedPrunedRoots,
    actualPrunedFiles,
    payloadInventorySha256: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
  };
}
