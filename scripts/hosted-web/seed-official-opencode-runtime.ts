import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { HostedOpenCodeCurrentManifestV2 } from '@features/hosted-opencode-runtime';
import {
  installHostedOpenCodeRuntime,
  resolveHostedOpenCodeRuntimeBinary,
} from '@main/composition/hosted/infrastructure/HostedOpenCodeRuntimeInstaller';
import { readHostedOpenCodeProductionLock } from '@main/composition/hosted/hostedOpenCodeRuntimeProduction';

const IMAGE_RUNTIME_ROOT = '/data/.agent-teams/data/hosted-opencode-runtime';
const IMAGE_ARCHIVE_ROOT = '/app/official-opencode-runtime';
const IMAGE_LOCK_FILE = '/app/opencode-hosted-runtime.lock.json';

interface SeedInput {
  readonly runtimeRoot?: string;
  readonly archiveRoot?: string;
  readonly loadLock?: () => Promise<unknown>;
  readonly fetch?: typeof globalThis.fetch;
  readonly executeVersion?: (binaryPath: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/** Docker build only: publish the verified executable and retain its verified release archive. */
export async function seedOfficialOpenCodeRuntime(
  input: SeedInput = {}
): Promise<HostedOpenCodeCurrentManifestV2> {
  const runtimeRoot = input.runtimeRoot ?? IMAGE_RUNTIME_ROOT;
  const archiveRoot = input.archiveRoot ?? IMAGE_ARCHIVE_ROOT;
  const lock = await (
    input.loadLock ?? (() => readHostedOpenCodeProductionLock(IMAGE_LOCK_FILE))
  )();
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeRoot, 0o700);
  await fs.mkdir(archiveRoot, { recursive: true, mode: 0o755 });
  const manifest = await installHostedOpenCodeRuntime({
    runtimeRoot,
    lock,
    fetch: input.fetch,
    executeVersion: input.executeVersion,
    platform: input.platform,
    arch: input.arch,
    onVerifiedArchive: async (archive, file) => {
      const archivePath = path.join(archiveRoot, file);
      await fs.writeFile(archivePath, archive, { flag: 'wx', mode: 0o444 });
      await fs.chmod(archivePath, 0o444);
    },
  });
  const binaryPath = await resolveHostedOpenCodeRuntimeBinary({
    runtimeRoot,
    lock,
    platform: input.platform,
    arch: input.arch,
  });
  if (binaryPath !== manifest.binaryPath) throw new Error('hosted_opencode_seed_binary_mismatch');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = await seedOfficialOpenCodeRuntime();
  process.stdout.write(
    `hosted-opencode-image-seed-ok:${manifest.version}:${manifest.platform}:${manifest.binarySha256}\n`
  );
}
