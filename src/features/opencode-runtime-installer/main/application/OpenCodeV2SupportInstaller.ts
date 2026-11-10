import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';

import runtimeLock from '../../../../../runtime.lock.json';
import {
  parseOpenCodeV2InstalledReceipt,
  readOpenCodeV2DeliveryMap,
  V2_SUPPORT_REQUIRED_MESSAGE,
} from '../../core/domain/v2Delivery';
import {
  downloadV2SupportArchive,
  extractV2SupportArchive,
  readV2SupportManifest,
  regularV2SupportFile,
  verifyV2SupportFiles,
} from '../infrastructure/v2SupportArchive';

import type {
  OpenCodeV2DeliveryDescriptor,
  OpenCodeV2InstalledReceipt,
} from '../../core/domain/v2Delivery';
import type { OpenCodeRuntimeInstallProgress, OpenCodeRuntimeStatus } from '@shared/types';

export function getOpenCodeV2SupportRoot(): string {
  return path.join(getAppDataPath(), 'runtimes', 'opencode-v2');
}

interface SupportInstallerOptions {
  lock?: unknown;
  cacheRoot?: () => string;
  platform?: string;
  arch?: string;
}

/** One descriptor's location state; immutable instances remain owned by their active runs. */
export class OpenCodeV2SupportInstaller {
  private readonly root: () => string;
  private readonly lock: unknown;
  private readonly platformKey: string;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: SupportInstallerOptions = {}) {
    this.lock = options.lock ?? runtimeLock;
    this.root = options.cacheRoot ?? getOpenCodeV2SupportRoot;
    this.platformKey = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  }

  private descriptor(nativeVersion?: string): OpenCodeV2DeliveryDescriptor | null {
    if (!nativeVersion?.startsWith('2.')) return null;
    const map = readOpenCodeV2DeliveryMap(this.lock);
    if (!map) return null;
    const descriptor = map[this.platformKey];
    if (!descriptor) throw new Error('OpenCode V2 support is not qualified for this platform');
    return descriptor;
  }

  async withStatus(status: OpenCodeRuntimeStatus): Promise<OpenCodeRuntimeStatus> {
    if (!status.installed || !status.version?.startsWith('2.')) return status;
    try {
      const descriptor = this.descriptor(status.version);
      if (!descriptor) return status;
      await this.readInstalled(descriptor, false);
      return { ...status, v2Support: 'ready' };
    } catch (error) {
      return {
        ...status,
        v2Support: 'required',
        state: 'idle',
        error: `${V2_SUPPORT_REQUIRED_MESSAGE} ${error instanceof Error ? error.message : 'Support unavailable'}`,
      };
    }
  }

  async install(
    nativeVersion: string,
    progress: (value: OpenCodeRuntimeInstallProgress) => void
  ): Promise<void> {
    const descriptor = this.descriptor(nativeVersion);
    if (!descriptor) return;
    const key = path.join(this.root(), descriptor.archive.sha256);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.installDescriptor(descriptor, progress).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private descriptorDirectory(descriptor: OpenCodeV2DeliveryDescriptor): string {
    return path.join(
      this.root(),
      descriptor.runtimeVersion,
      `${descriptor.platform}-${descriptor.arch}`,
      descriptor.archive.sha256
    );
  }

  private async checkedDirectory(directory: string, create: boolean): Promise<string> {
    const root = path.resolve(this.root());
    if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = await fs.realpath(root);
    let current = canonical;
    const relative = path.relative(root, directory);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (create)
        await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      if (!(await fs.lstat(current)).isDirectory())
        throw new Error('OpenCode V2 support path is not a regular directory');
    }
    return current;
  }

  private async readInstalled(
    descriptor: OpenCodeV2DeliveryDescriptor,
    full: boolean
  ): Promise<string> {
    const directory = await this.checkedDirectory(this.descriptorDirectory(descriptor), false);
    const receiptFile = path.join(directory, 'installed.json');
    const stat = await fs.lstat(receiptFile);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid OpenCode V2 support receipt');
    const receipt = parseOpenCodeV2InstalledReceipt(
      JSON.parse(await fs.readFile(receiptFile, 'utf8')),
      descriptor
    );
    const root = path.join(directory, receipt.instance);
    if (!(await fs.lstat(root)).isDirectory())
      throw new Error('Invalid OpenCode V2 support instance');
    const manifest = await readV2SupportManifest(root, descriptor);
    if (full) await verifyV2SupportFiles(root, manifest);
    else
      for (const helper of [
        'opencodeV2Server.js',
        'opencodeV2ExecutionServer.js',
        'opencodeV2RunOwner.js',
        'opencode-v2-graphs.json',
      ]) {
        const relative = `local-cli/${helper}`;
        const file = await regularV2SupportFile(root, relative);
        if (
          (await fs.lstat(file)).size !== manifest.files.find((row) => row.path === relative)?.bytes
        )
          throw new Error('Incomplete OpenCode V2 support instance');
      }
    return root;
  }

  private async installDescriptor(
    descriptor: OpenCodeV2DeliveryDescriptor,
    progress: (value: OpenCodeRuntimeInstallProgress) => void
  ): Promise<void> {
    try {
      await this.readInstalled(descriptor, true);
      return;
    } catch {
      /* Explicit install repairs corrupt or absent support. */
    }
    const directory = await this.checkedDirectory(this.descriptorDirectory(descriptor), true);
    const instance = randomUUID();
    const staging = path.join(directory, `.staging-${instance}`);
    const archive = path.join(directory, `.download-${instance}.zip`);
    let published = false;
    try {
      await fs.mkdir(staging, { mode: 0o700 });
      const lock = this.lock as { releaseRepository: string; releaseTag: string };
      if (
        lock.releaseRepository !== '777genius/agent_teams_orchestrator_binaries' ||
        lock.releaseTag !== `runtime-v${descriptor.runtimeVersion}`
      )
        throw new Error('Invalid OpenCode V2 support release identity');
      const url = `https://github.com/${lock.releaseRepository}/releases/download/${lock.releaseTag}/${encodeURIComponent(descriptor.archive.file)}`;
      await downloadV2SupportArchive(url, archive, descriptor, (downloadedBytes, totalBytes) =>
        progress({
          phase: 'downloading',
          downloadedBytes,
          totalBytes,
          percent: Math.floor((downloadedBytes / totalBytes) * 100),
          detail: 'Downloading OpenCode V2 support...',
        })
      );
      progress({ phase: 'installing', detail: 'Verifying OpenCode V2 support...' });
      await extractV2SupportArchive(archive, staging, descriptor);
      await renamePathWithRetry(staging, path.join(directory, instance));
      published = true;
      const receipt: OpenCodeV2InstalledReceipt = {
        schemaVersion: 1,
        runtimeVersion: descriptor.runtimeVersion,
        sourceCommit: descriptor.sourceCommit,
        bridgeProtocol: 1,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archiveSha256: descriptor.archive.sha256,
        manifestSha256: descriptor.manifest.sha256,
        instance,
      };
      await atomicWriteAsync(
        path.join(directory, 'installed.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        {
          mode: 0o600,
          directoryMode: 0o700,
          durability: 'strict',
          syncDirectory: true,
        }
      );
      await this.readInstalled(descriptor, false);
    } catch (error) {
      // Publication may have committed before a directory sync failed, or another process won.
      // Observe that completed state; never restore an older receipt over it.
      try {
        await this.readInstalled(descriptor, true);
        return;
      } catch {
        throw error;
      }
    } finally {
      await fs.rm(archive, { force: true });
      if (!published) await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
