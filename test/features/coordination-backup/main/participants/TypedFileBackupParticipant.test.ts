import {
  type BackupManifestEntry,
  parseBackupRunId,
} from '@features/coordination-backup/contracts';
import { sha256Bytes } from '@features/coordination-backup/main/infrastructure';
import {
  TypedFileBackupParticipant,
  type TypedFileBackupSource,
  type TypedFileBackupSourceSnapshot,
} from '@features/coordination-backup/main/participants';
import { describe, expect, it, vi } from 'vitest';

import type {
  BackupArtifactWriteRequest,
  BackupPublicationArtifactWriter,
} from '@features/coordination-backup/main/infrastructure';

const RUN_ID = parseBackupRunId('backup_typed-file-001');
const FENCE = { generation: 9, admittedRunId: RUN_ID } as const;
type IdentityGeneration = string & { readonly identityGeneration: unique symbol };
const GENERATION = 'identity-generation-9' as IdentityGeneration;

describe('TypedFileBackupParticipant', () => {
  it('carries typed generation/barrier/exclusions and stages bytes only through the writer', async () => {
    const snapshot = makeSnapshot();
    const source: TypedFileBackupSource<IdentityGeneration> = {
      readSnapshot: vi.fn(() => Promise.resolve(snapshot)),
    };
    const writer = new MemoryArtifactWriter();
    const participant = makeParticipant(source, writer);

    const prepared = await participant.prepare({ backupRunId: RUN_ID, fence: FENCE });
    const flushed = await participant.flush({
      backupRunId: RUN_ID,
      fence: FENCE,
      prepared,
    });
    const staged = await participant.stage({
      backupRunId: RUN_ID,
      fence: FENCE,
      flushed,
    });
    const verification = await participant.verify({
      backupRunId: RUN_ID,
      fence: FENCE,
      flushed,
      stagedEntries: staged.entries,
    });

    expect(prepared.sourceGeneration).toBe(GENERATION);
    expect(flushed.durableBarrier).toBe('identity-barrier-9');
    expect(staged.exclusions).toEqual([
      {
        participantId: 'identity',
        logicalType: 'provider-session',
        reason: 'session_or_ticket',
      },
    ]);
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0]).not.toHaveProperty('sourcePath');
    expect([...writer.requests[0].bytes]).toEqual([...snapshot.bytes]);
    expect(verification).toEqual({ status: 'verified' });
  });

  it('fails when the typed generation changes between prepare and flush', async () => {
    let snapshot = makeSnapshot();
    const source: TypedFileBackupSource<IdentityGeneration> = {
      readSnapshot: () => Promise.resolve(snapshot),
    };
    const participant = makeParticipant(source, new MemoryArtifactWriter());
    const prepared = await participant.prepare({ backupRunId: RUN_ID, fence: FENCE });
    snapshot = {
      ...snapshot,
      generation: 'identity-generation-10' as IdentityGeneration,
    };

    await expect(
      participant.flush({ backupRunId: RUN_ID, fence: FENCE, prepared })
    ).rejects.toThrow('source-generation-changed-before-flush');
  });

  it('fails verification when the barrier or bytes drift after staging', async () => {
    let snapshot = makeSnapshot();
    const source: TypedFileBackupSource<IdentityGeneration> = {
      readSnapshot: () => Promise.resolve(snapshot),
    };
    const participant = makeParticipant(source, new MemoryArtifactWriter());
    const prepared = await participant.prepare({ backupRunId: RUN_ID, fence: FENCE });
    const flushed = await participant.flush({
      backupRunId: RUN_ID,
      fence: FENCE,
      prepared,
    });
    const staged = await participant.stage({ backupRunId: RUN_ID, fence: FENCE, flushed });
    snapshot = { ...snapshot, durableBarrier: 'identity-barrier-10', bytes: Buffer.from('drift') };

    await expect(
      participant.verify({
        backupRunId: RUN_ID,
        fence: FENCE,
        flushed,
        stagedEntries: staged.entries,
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'source-evidence-changed-after-flush' });
  });

  it('rejects any undeclared source surface instead of accepting a leaked path capability', async () => {
    const source = {
      readSnapshot: () => Promise.resolve({ ...makeSnapshot(), rootPath: '/forbidden' }),
    } satisfies TypedFileBackupSource<IdentityGeneration>;
    const participant = makeParticipant(source, new MemoryArtifactWriter());

    await expect(participant.prepare({ backupRunId: RUN_ID, fence: FENCE })).rejects.toThrow(
      'source-snapshot-surface-invalid'
    );
  });

  it.each(['non-enumerable string', 'symbol'] as const)(
    'rejects a hidden filesystem capability stored in a %s property',
    async (propertyKind) => {
      const snapshot = makeSnapshot() as TypedFileBackupSourceSnapshot<IdentityGeneration> &
        Record<PropertyKey, unknown>;
      if (propertyKind === 'symbol') {
        snapshot[Symbol('rootPath')] = '/forbidden';
      } else {
        Object.defineProperty(snapshot, 'rootPath', {
          configurable: true,
          enumerable: false,
          value: '/forbidden',
        });
      }
      const source: TypedFileBackupSource<IdentityGeneration> = {
        readSnapshot: () => Promise.resolve(snapshot),
      };
      const participant = makeParticipant(source, new MemoryArtifactWriter());

      await expect(participant.prepare({ backupRunId: RUN_ID, fence: FENCE })).rejects.toThrow(
        'source-snapshot-surface-invalid'
      );
    }
  );
});

function makeParticipant(
  source: TypedFileBackupSource<IdentityGeneration>,
  artifactWriter: BackupPublicationArtifactWriter
) {
  return new TypedFileBackupParticipant({
    descriptor: {
      participantId: 'identity',
      kind: 'identity_anchor',
      contractVersion: 1,
      schemaVersion: 1,
      required: true,
    },
    entry: {
      entryId: 'identity/deployment.json',
      kind: 'identity_anchor',
      logicalOwner: 'deployment-identity',
      logicalType: 'application/json',
      schemaVersion: 1,
      mode: 0o600,
    },
    source,
    artifactWriter,
  });
}

function makeSnapshot(): TypedFileBackupSourceSnapshot<IdentityGeneration> {
  return {
    bytes: Buffer.from('{"deploymentId":"deployment_test"}'),
    generation: GENERATION,
    durableBarrier: 'identity-barrier-9',
    exclusions: [{ logicalType: 'provider-session', reason: 'session_or_ticket' }],
  };
}

class MemoryArtifactWriter implements BackupPublicationArtifactWriter {
  readonly requests: BackupArtifactWriteRequest[] = [];
  private entry: BackupManifestEntry | null = null;

  writeArtifact(request: BackupArtifactWriteRequest): Promise<BackupManifestEntry> {
    this.requests.push(request);
    this.entry = {
      entryId: request.entryId,
      participantId: request.participantId,
      kind: request.kind,
      logicalOwner: request.logicalOwner,
      logicalType: request.logicalType,
      schemaVersion: request.schemaVersion,
      byteLength: request.bytes.byteLength,
      mode: request.mode,
      sha256: sha256Bytes(request.bytes),
      sourceGeneration: request.sourceGeneration,
    };
    return Promise.resolve(this.entry);
  }

  measureStagedArtifact() {
    if (!this.entry) return Promise.reject(new Error('artifact-not-written'));
    return Promise.resolve({
      entryId: this.entry.entryId,
      byteLength: this.entry.byteLength,
      mode: this.entry.mode,
      sha256: this.entry.sha256,
    });
  }
}
