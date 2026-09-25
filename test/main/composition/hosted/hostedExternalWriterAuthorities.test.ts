/* eslint-disable @typescript-eslint/require-await -- In-memory fakes satisfy async storage and file ports. */
import { createHash } from 'node:crypto';

import {
  type ExternalFileRegistration,
  type ExternalFileStat,
  type ExternalWriterObservationStateStore,
  ExternalWriterObserver,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';
import {
  HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
  HostedMessageExternalWriterReconciler,
} from '@features/team-message-delivery/main/hosted';
import { HostedMessageExternalWriterJournalAuthority } from '@main/composition/hosted/hostedExternalWriterAuthorities';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted/identifiers';
import { describe, expect, it } from 'vitest';

import type { TeamIdentityRecord } from '@features/internal-storage/contracts';
import type {
  ExternalWriterReconciliationReceipt,
  ExternalWriterReconciliationStorageGateway,
} from '@features/internal-storage/main';

const teamId = parseTeamId('team_44444444444444444444444444444444');
const workspaceId = parseWorkspaceId('workspace_55555555555555555555555555555555');
const registration: ExternalFileRegistration = {
  scope: { teamId, featureKey: HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY },
  fileKey: 'team-lead',
  maxBytes: 64 * 1_024,
  attributionPolicy: 'external_file_only',
};

const inbox = (text: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([{ from: 'user', text, timestamp: '2026-09-25T10:00:00.000Z' }])
  );
const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
/** The checksum-derived generation the journal authority used to report. */
const checksumGeneration = (content: Uint8Array): number =>
  Number(BigInt(`0x${sha256(content)}`) % BigInt(Number.MAX_SAFE_INTEGER));

class MemoryStateStore implements ExternalWriterObservationStateStore {
  private checkpoint: FileObservationStateCheckpoint | null = null;

  async load(): Promise<FileObservationStateCheckpoint | null> {
    return this.checkpoint;
  }

  async consumeCleanHandoffEligibility(): Promise<FileObservationStateCheckpoint | null> {
    return null;
  }

  async listHotTeamIds(): Promise<readonly (typeof teamId)[]> {
    return [];
  }

  async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }

  async saveCleanHandoffEligibility(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }
}

class MemoryReconciliationStorage implements ExternalWriterReconciliationStorageGateway {
  readonly eventIds: string[] = [];
  private readonly receipts = new Map<string, ExternalWriterReconciliationReceipt>();

  async getExternalWriterReconciliation(input: {
    readonly reconciliationId: string;
  }): Promise<ExternalWriterReconciliationReceipt | null> {
    return this.receipts.get(input.reconciliationId) ?? null;
  }

  async commitExternalWriterReconciliation(
    input: Parameters<
      ExternalWriterReconciliationStorageGateway['commitExternalWriterReconciliation']
    >[0]
  ): ReturnType<ExternalWriterReconciliationStorageGateway['commitExternalWriterReconciliation']> {
    const existing = this.receipts.get(input.receipt.reconciliationId);
    if (existing) {
      return existing.inputSha256 === input.receipt.inputSha256
        ? { outcome: 'idempotent_replay', receipt: existing }
        : { outcome: 'input_conflict', receipt: null };
    }
    const receipt = { ...input.receipt, eventBodyJson: JSON.stringify(input.event) };
    this.receipts.set(receipt.reconciliationId, receipt);
    this.eventIds.push(input.event.eventId);
    return { outcome: 'committed', receipt };
  }
}

function activeIdentity(): TeamIdentityRecord {
  return {
    teamId,
    state: 'active',
    legacyKey: 'sandbox-team' as TeamIdentityRecord['legacyKey'],
    directoryFingerprint: 'a'.repeat(64) as TeamIdentityRecord['directoryFingerprint'],
    workspaceBinding: { workspaceId, generation: 1 },
    adoptionIntentId: null,
    identityChecksum: 'b'.repeat(64) as TeamIdentityRecord['identityChecksum'],
    createdAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:00.000Z',
    tombstonedAt: null,
  };
}

describe('hosted external-writer journal authority', () => {
  it('lets the observer settle an inbox edit instead of recommitting it on every rescan', async () => {
    const first = inbox('first');
    const second = inbox('second');
    // The regression needs an edit whose checksum-derived generation is lower than the prior one.
    expect(checksumGeneration(second)).toBeLessThan(checksumGeneration(first));

    let content = first;
    let version = 1;
    const stat = (): ExternalFileStat => ({
      kind: 'file',
      contained: true,
      byteLength: content.byteLength,
      device: 'device-1',
      inode: 'inode-1',
      modifiedTimeNs: String(version),
      changedTimeNs: String(version),
    });
    const storage = new MemoryReconciliationStorage();
    const observer = new ExternalWriterObserver({
      watch: { start: async () => ({ close: async () => undefined }) },
      catalog: {
        listScopes: async () => [registration.scope],
        listRegistrations: async () => [registration],
      },
      source: {
        stat: async () => stat(),
        read: async () => content,
        confirmAbsentByParentRescan: async () => false,
      },
      checksums: { checksum: sha256 },
      reconciliation: new HostedMessageExternalWriterReconciler(
        new HostedMessageExternalWriterJournalAuthority({
          deploymentId: 'deployment-external-writer-test',
          storage,
          notifyDurableCommit: async () => undefined,
          teamIdentities: { getTeamIdentity: async () => activeIdentity() },
        })
      ),
      stateStore: new MemoryStateStore(),
      clock: { nowMs: () => 0, sleep: async () => undefined },
    });

    await observer.start();
    expect(storage.eventIds).toHaveLength(1);

    content = second;
    version += 1;
    // The production watch port requests one of these scope rescans every second.
    for (let rescan = 0; rescan < 3; rescan += 1) {
      await observer.rescanScope(registration.scope);
    }

    expect(storage.eventIds).toHaveLength(2);
    expect(observer.getSnapshot().readiness).toBe('clean');
  });
});
