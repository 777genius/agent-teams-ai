import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  type RegisteredExternalFile,
  RegisteredExternalFileCatalog,
} from './RegisteredExternalFileCatalog';

import type {
  ExternalFileRegistration,
  ExternalFileStat,
  ExternalFileStatIdentity,
} from '../../contracts';
import type { ExternalFileObservationSource } from '../../core/application';

export type NodeExternalFileObservationSourceErrorCode =
  | 'invalid_max_bytes'
  | 'outside_containment'
  | 'oversized'
  | 'symlink_not_allowed'
  | 'unstable'
  | 'unsupported_file_type';

export class NodeExternalFileObservationSourceError extends Error {
  constructor(readonly code: NodeExternalFileObservationSourceErrorCode) {
    super(`node-external-file-observation-source:${code}`);
    this.name = 'NodeExternalFileObservationSourceError';
  }
}

interface BigIntStatIdentity {
  byteLength: bigint;
  device: bigint;
  inode: bigint;
  modifiedTimeNs: bigint;
  changedTimeNs: bigint;
}

const isMissingError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const platformPathKey = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path;

const pathsEqual = (left: string, right: string): boolean =>
  platformPathKey(resolve(left)) === platformPathKey(resolve(right));

const isPathInsideOrEqual = (rootPath: string, candidatePath: string): boolean => {
  if (pathsEqual(rootPath, candidatePath)) {
    return true;
  }
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const safeByteLength = (size: bigint): number =>
  size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);

const toBigIntIdentity = (stat: {
  size: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): BigIntStatIdentity => ({
  byteLength: stat.size,
  device: stat.dev,
  inode: stat.ino,
  modifiedTimeNs: stat.mtimeNs,
  changedTimeNs: stat.ctimeNs,
});

const toExternalIdentity = (identity: BigIntStatIdentity): ExternalFileStatIdentity => ({
  byteLength: safeByteLength(identity.byteLength),
  device: identity.device.toString(),
  inode: identity.inode.toString(),
  modifiedTimeNs: identity.modifiedTimeNs.toString(),
  changedTimeNs: identity.changedTimeNs.toString(),
});

const identitiesEqual = (left: BigIntStatIdentity, right: BigIntStatIdentity): boolean =>
  left.byteLength === right.byteLength &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedTimeNs === right.modifiedTimeNs &&
  left.changedTimeNs === right.changedTimeNs;

const unavailableStat = (kind: ExternalFileStat['kind'], contained: boolean): ExternalFileStat => ({
  kind,
  contained,
  byteLength: 0,
  device: null,
  inode: null,
  modifiedTimeNs: null,
  changedTimeNs: null,
});

export class NodeExternalFileObservationSource implements ExternalFileObservationSource {
  constructor(private readonly catalog: RegisteredExternalFileCatalog) {}

  async stat(registration: ExternalFileRegistration): Promise<ExternalFileStat> {
    const file = this.catalog.getRegisteredFile(registration);
    if (!(await this.hasStableRootAndParent(file))) {
      return unavailableStat('other', false);
    }

    let observed;
    try {
      observed = await lstat(file.filePath, { bigint: true });
    } catch (error) {
      if (isMissingError(error)) {
        return unavailableStat('missing', true);
      }
      throw error;
    }

    if (observed.isSymbolicLink()) {
      const targetPath = await realpath(file.filePath).catch(() => null);
      return unavailableStat(
        'symlink',
        targetPath === null ||
          (pathsEqual(targetPath, file.realFilePath) &&
            isPathInsideOrEqual(file.realRootPath, targetPath))
      );
    }

    const targetPath = await realpath(file.filePath).catch(() => null);
    const contained =
      targetPath !== null &&
      pathsEqual(targetPath, file.realFilePath) &&
      isPathInsideOrEqual(file.realRootPath, targetPath);
    if (!observed.isFile()) {
      return unavailableStat(observed.isDirectory() ? 'directory' : 'other', contained);
    }
    const identity = toExternalIdentity(toBigIntIdentity(observed));
    return {
      kind: 'file',
      contained,
      ...identity,
    };
  }

  async read(registration: ExternalFileRegistration, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new NodeExternalFileObservationSourceError('invalid_max_bytes');
    }
    const file = this.catalog.getRegisteredFile(registration);
    const effectiveMaxBytes = Math.min(maxBytes, file.registration.maxBytes);
    const before = await this.stat(file.registration);
    this.assertReadableStat(before, effectiveMaxBytes);

    const handle = await open(file.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile()) {
        throw new NodeExternalFileObservationSourceError('unsupported_file_type');
      }
      const openedIdentity = toBigIntIdentity(openedStat);
      if (openedIdentity.byteLength > BigInt(effectiveMaxBytes)) {
        throw new NodeExternalFileObservationSourceError('oversized');
      }
      if (
        openedIdentity.device.toString() !== before.device ||
        openedIdentity.inode.toString() !== before.inode ||
        !this.externalAndBigIntIdentitiesEqual(before, openedIdentity)
      ) {
        throw new NodeExternalFileObservationSourceError('unstable');
      }
      await this.assertOpenPathContained(file, openedIdentity);

      const expectedLength = Number(openedIdentity.byteLength);
      const content = Buffer.alloc(expectedLength);
      let offset = 0;
      while (offset < expectedLength) {
        const result = await handle.read(content, offset, expectedLength - offset, offset);
        if (result.bytesRead === 0) {
          throw new NodeExternalFileObservationSourceError('unstable');
        }
        offset += result.bytesRead;
      }

      const afterHandleStat = await handle.stat({ bigint: true });
      const afterIdentity = toBigIntIdentity(afterHandleStat);
      if (afterIdentity.byteLength > BigInt(effectiveMaxBytes)) {
        throw new NodeExternalFileObservationSourceError('oversized');
      }
      if (!afterHandleStat.isFile() || !identitiesEqual(openedIdentity, afterIdentity)) {
        throw new NodeExternalFileObservationSourceError('unstable');
      }
      await this.assertOpenPathContained(file, afterIdentity);
      return new Uint8Array(content);
    } finally {
      await handle.close();
    }
  }

  async confirmAbsentByParentRescan(registration: ExternalFileRegistration): Promise<boolean> {
    const file = this.catalog.getRegisteredFile(registration);
    if (!(await this.hasStableRootAndParent(file))) {
      return false;
    }
    try {
      await lstat(file.filePath);
      return false;
    } catch (error) {
      return isMissingError(error);
    }
  }

  private assertReadableStat(stat: ExternalFileStat, maxBytes: number): void {
    if (stat.kind === 'symlink') {
      throw new NodeExternalFileObservationSourceError('symlink_not_allowed');
    }
    if (!stat.contained) {
      throw new NodeExternalFileObservationSourceError('outside_containment');
    }
    if (stat.kind !== 'file') {
      throw new NodeExternalFileObservationSourceError('unsupported_file_type');
    }
    if (!Number.isSafeInteger(stat.byteLength) || stat.byteLength > maxBytes) {
      throw new NodeExternalFileObservationSourceError('oversized');
    }
  }

  private externalAndBigIntIdentitiesEqual(
    external: ExternalFileStat,
    identity: BigIntStatIdentity
  ): boolean {
    return (
      external.byteLength === safeByteLength(identity.byteLength) &&
      external.device === identity.device.toString() &&
      external.inode === identity.inode.toString() &&
      external.modifiedTimeNs === identity.modifiedTimeNs.toString() &&
      external.changedTimeNs === identity.changedTimeNs.toString()
    );
  }

  private async hasStableRootAndParent(file: RegisteredExternalFile): Promise<boolean> {
    return this.catalog.isRootAndParentCurrent(file);
  }

  private async assertOpenPathContained(
    file: RegisteredExternalFile,
    openedIdentity: BigIntStatIdentity
  ): Promise<void> {
    if (!(await this.hasStableRootAndParent(file))) {
      throw new NodeExternalFileObservationSourceError('outside_containment');
    }
    let targetStat;
    let observedFilePath: string;
    try {
      [targetStat, observedFilePath] = await Promise.all([
        lstat(file.filePath, { bigint: true }),
        realpath(file.filePath),
      ]);
    } catch {
      throw new NodeExternalFileObservationSourceError('unstable');
    }
    if (targetStat.isSymbolicLink()) {
      throw new NodeExternalFileObservationSourceError('symlink_not_allowed');
    }
    if (!targetStat.isFile() || !identitiesEqual(toBigIntIdentity(targetStat), openedIdentity)) {
      throw new NodeExternalFileObservationSourceError('unstable');
    }
    if (
      !pathsEqual(observedFilePath, file.realFilePath) ||
      !isPathInsideOrEqual(file.realRootPath, observedFilePath)
    ) {
      throw new NodeExternalFileObservationSourceError('outside_containment');
    }
  }
}
