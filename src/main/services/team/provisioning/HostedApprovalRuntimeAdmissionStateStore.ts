import { createHash } from 'node:crypto';

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
const STATE_QUEUES = new Map<string, Promise<unknown>>();

/** Trusted app-state implementation. The caller supplies a pre-opened 0700 directory capability. */
export class DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore implements HostedApprovalRuntimeAdmissionStateStore {
  constructor(private readonly openStateDirectory: () => Promise<TrustedDirectoryCapability>) {}

  load(teamId: string): Promise<HostedApprovalRuntimeAdmissionState | null> {
    return this.serialized(teamId, async () => {
      const directory = await this.open(teamId);
      try {
        return await readState(directory, stateFileName(teamId));
      } finally {
        await directory.handle.close();
      }
    });
  }

  compareAndSwap(
    teamId: string,
    expectedRevision: number | null,
    next: HostedApprovalRuntimeAdmissionState
  ): Promise<boolean> {
    return this.serialized(teamId, async () => {
      validateState(next);
      if (next.revision !== (expectedRevision ?? 0) + 1) {
        throw new Error('hosted-approval-runtime-state-revision-invalid');
      }
      const directory = await this.open(teamId);
      const name = stateFileName(teamId);
      try {
        const current = await readState(directory, name);
        if ((current?.revision ?? null) !== expectedRevision) return false;
        const body = `${JSON.stringify(next)}\n`;
        await descriptorAnchoredReplace(directory, name, body, {
          beforeRename: async () => {
            const latest = await readState(directory, name);
            if ((latest?.revision ?? null) !== expectedRevision) {
              throw new Error('hosted-approval-runtime-state-conflict');
            }
          },
        });
        return true;
      } finally {
        await directory.handle.close();
      }
    });
  }

  private async open(teamId: string): Promise<TrustedDirectoryCapability> {
    if (!TEAM_ID.test(teamId)) throw new TypeError('hosted-approval-runtime-state-team-invalid');
    const directory = await this.openStateDirectory();
    await validateTrustedDirectoryCapability(directory);
    return directory;
  }

  private serialized<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    const prior = STATE_QUEUES.get(teamId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    STATE_QUEUES.set(teamId, next);
    const cleanup = () => {
      if (STATE_QUEUES.get(teamId) === next) STATE_QUEUES.delete(teamId);
    };
    void next.then(cleanup, cleanup);
    return next;
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
