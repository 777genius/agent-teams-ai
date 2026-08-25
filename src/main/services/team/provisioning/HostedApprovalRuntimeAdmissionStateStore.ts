import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { lock } from 'proper-lockfile';

import {
  descriptorAnchoredRead,
  descriptorAnchoredReplace,
  validateTrustedDirectoryCapability,
} from './HostedApprovalRuntimeDescriptorStorage';

import type {
  HostedApprovalRuntimeAdmissionState,
  HostedApprovalRuntimeAdmissionStateStore,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type { TrustedDirectoryCapability } from './HostedApprovalRuntimeDescriptorStorage';

const FINGERPRINT = /^[0-9a-f]{64}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const COMMIT_LOCK_NAME = '.hosted-approval-runtime-admission.commit.lock';

/** Trusted app-state implementation. The caller supplies a pre-opened 0700 directory capability. */
export class DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore implements HostedApprovalRuntimeAdmissionStateStore {
  constructor(private readonly openStateDirectory: () => Promise<TrustedDirectoryCapability>) {}

  load(teamId: string): Promise<HostedApprovalRuntimeAdmissionState | null> {
    return this.withCommitLock(teamId, (locked) => locked.load(teamId));
  }

  compareAndSwap(
    teamId: string,
    expectedRevision: number | null,
    next: HostedApprovalRuntimeAdmissionState
  ): Promise<boolean> {
    return this.withCommitLock(teamId, (locked) =>
      locked.compareAndSwap(teamId, expectedRevision, next)
    );
  }

  async withCommitLock<T>(
    scope: string,
    operation: (
      locked: Pick<HostedApprovalRuntimeAdmissionStateStore, 'load' | 'compareAndSwap'>
    ) => Promise<T>
  ): Promise<T> {
    if (!scope.trim()) throw new TypeError('hosted-approval-runtime-state-scope-invalid');
    const directory = await this.openDirectory();
    const lockPath = join(directory.identity.canonicalPath, COMMIT_LOCK_NAME);
    let compromised: Error | null = null;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lock(directory.identity.canonicalPath, {
        lockfilePath: lockPath,
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 80, factor: 1.15, minTimeout: 10, maxTimeout: 150, randomize: true },
        onCompromised: (error) => {
          compromised = error;
        },
      });
      await directory.handle.sync();
      await validateCommitLock(directory, lockPath);
      const assertOwned = async (): Promise<void> => {
        if (compromised) {
          throw new Error('hosted-approval-runtime-state-lock-compromised', {
            cause: compromised,
          });
        }
        await validateTrustedDirectoryCapability(directory);
        await validateCommitLock(directory, lockPath);
      };
      const locked = Object.freeze({
        load: async (teamId: string) => {
          await assertOwned();
          if (!TEAM_ID.test(teamId)) {
            throw new TypeError('hosted-approval-runtime-state-team-invalid');
          }
          return readState(directory, stateFileName(teamId));
        },
        compareAndSwap: async (
          teamId: string,
          expectedRevision: number | null,
          next: HostedApprovalRuntimeAdmissionState
        ) => {
          await assertOwned();
          validateState(next);
          if (!TEAM_ID.test(teamId)) {
            throw new TypeError('hosted-approval-runtime-state-team-invalid');
          }
          if (next.revision !== (expectedRevision ?? 0) + 1) {
            throw new Error('hosted-approval-runtime-state-revision-invalid');
          }
          const name = stateFileName(teamId);
          const current = await readState(directory, name);
          if ((current?.revision ?? null) !== expectedRevision) return false;
          await descriptorAnchoredReplace(directory, name, `${JSON.stringify(next)}\n`, {
            beforeRename: async () => {
              await assertOwned();
              const latest = await readState(directory, name);
              if ((latest?.revision ?? null) !== expectedRevision) {
                throw new Error('hosted-approval-runtime-state-conflict');
              }
            },
          });
          await assertOwned();
          return true;
        },
      });
      const result = await operation(locked);
      await assertOwned();
      return result;
    } finally {
      try {
        await release?.();
      } finally {
        await directory.handle.sync().catch(() => undefined);
        await directory.handle.close().catch(() => undefined);
      }
    }
  }

  private async openDirectory(): Promise<TrustedDirectoryCapability> {
    const directory = await this.openStateDirectory();
    await validateTrustedDirectoryCapability(directory);
    return directory;
  }
}

async function validateCommitLock(
  directory: TrustedDirectoryCapability,
  lockPath: string
): Promise<void> {
  const { lstat, open, readdir } = await import('node:fs/promises');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const before = await lstat(lockPath, { bigint: true });
    handle = await open(
      lockPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
    );
    if (process.platform !== 'win32') {
      await handle.chmod(0o700);
      await handle.sync();
    }
    const opened = await handle.stat({ bigint: true });
    const membership = await lstat(lockPath, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino === 0n ||
      opened.ino !== before.ino ||
      opened.dev !== membership.dev ||
      opened.ino !== membership.ino ||
      opened.uid !== BigInt(directory.identity.uid) ||
      opened.gid !== BigInt(directory.identity.gid) ||
      (process.platform !== 'win32' &&
        ((opened.mode & 0o777n) !== 0o700n || opened.nlink !== 2n)) ||
      // /proc-anchored listing is Linux-only; elsewhere the dev/ino membership
      // checks above pin lockPath to the opened handle, so the plain path is
      // the best available anchor.
      (await readdir(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : lockPath))
        .length !== 0
    ) {
      throw new Error('hosted-approval-runtime-state-lock-invalid');
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readState(
  directory: TrustedDirectoryCapability,
  name: string
): Promise<HostedApprovalRuntimeAdmissionState | null> {
  const body = await descriptorAnchoredRead(directory, name);
  if (body === null) return null;
  const parsed = JSON.parse(body) as HostedApprovalRuntimeAdmissionState;
  if (`${JSON.stringify(parsed)}\n` !== body) {
    throw new Error('hosted-approval-runtime-state-invalid');
  }
  validateState(parsed);
  return Object.freeze(parsed);
}

function validateState(state: HostedApprovalRuntimeAdmissionState): void {
  if (
    !state ||
    typeof state !== 'object' ||
    Object.keys(state).toSorted().join(',') !==
      'authoritativeFingerprint,generationHighWater,revision,schemaVersion' ||
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !Number.isSafeInteger(state.generationHighWater) ||
    state.generationHighWater < 1 ||
    !FINGERPRINT.test(state.authoritativeFingerprint)
  ) {
    throw new Error('hosted-approval-runtime-state-invalid');
  }
}

function stateFileName(teamId: string): string {
  return `hosted-approval-${createHash('sha256').update(teamId).digest('hex')}.state.json`;
}
