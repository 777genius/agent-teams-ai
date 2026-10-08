import { constants } from 'node:fs';

import { normalizePhysicalFault } from '../../core/application/physicalFault';

import type { PhysicalOutcome, RawReadTask } from '../../core/application/PhysicalReadScope';
import type { DescriptorAcquisition, OwnedReadDescriptors } from './OwnedReadDescriptors';

export interface OwnedSyncOptions {
  readonly target: 'file' | 'directory';
  readonly durability: 'strict' | 'best-effort';
}

export type OwnedSyncReport =
  | { readonly status: 'synced' }
  | { readonly status: 'unsupported' | 'best-effort-failed'; readonly fault: string };

const unsupportedDirectoryCodes = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
const unsupportedWindowsCodes = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);

function unsupportedDirectoryError(error: unknown, platform: NodeJS.Platform): boolean {
  try {
    if (typeof error !== 'object' || error === null) return false;
    const code: unknown = (error as { code?: unknown }).code;
    return (
      typeof code === 'string' &&
      (unsupportedDirectoryCodes.has(code) ||
        (platform === 'win32' && unsupportedWindowsCodes.has(code)))
    );
  } catch {
    return false;
  }
}

/** Durability policy never suppresses unconfirmed descriptor closure. */
export function syncOwnedPath(
  path: string,
  options: OwnedSyncOptions,
  owner: OwnedReadDescriptors
): RawReadTask<OwnedSyncReport> {
  const { target, durability } = options;
  if (target !== 'file' && target !== 'directory') throw new Error('Invalid sync target');
  if (durability !== 'strict' && durability !== 'best-effort')
    throw new Error('Invalid sync durability');
  const platform = process.platform;
  let acquisition: DescriptorAcquisition | undefined;
  let finish!: (outcome: PhysicalOutcome) => void;
  const physical = new Promise<PhysicalOutcome>((resolve) => {
    finish = resolve;
  });
  const result = (async (): Promise<OwnedSyncReport> => {
    let failure: unknown;
    let failed = false;
    let outcome: PhysicalOutcome;
    try {
      acquisition = owner.open(
        path,
        target === 'directory' ? constants.O_RDONLY : constants.O_RDWR
      );
      const descriptor = await acquisition.result;
      await descriptor.sync().result;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      outcome = acquisition
        ? await acquisition.close()
        : { kind: 'unknown', fault: 'Acquisition did not return its physical port' };
      finish(outcome);
    }
    if (outcome.kind === 'unknown') throw new Error(outcome.fault);
    if (!failed) return { status: 'synced' };
    const fault = normalizePhysicalFault(failure);
    if (target === 'directory' && unsupportedDirectoryError(failure, platform))
      return { status: 'unsupported', fault };
    if (durability === 'best-effort') return { status: 'best-effort-failed', fault };
    throw failure;
  })();
  void result.catch((error: unknown) => {
    // Protect the port if an unexpected helper failure occurs outside the native catch.
    finish({ kind: 'unknown', fault: normalizePhysicalFault(error) });
  });
  return { result, physical };
}
