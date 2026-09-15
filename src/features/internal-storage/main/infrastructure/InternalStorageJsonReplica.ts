import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { atomicWriteAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';

export interface InternalStorageJsonReplicaEnvelope<TSnapshot> {
  schemaVersion: 1;
  state: 'dirty' | 'clean';
  updatedAt: string;
  snapshot?: TSnapshot;
  /** Optional binding for opt-in authority recovery; legacy consumers do not grant recovery. */
  incarnation?: string;
}

export type InternalStorageReplicaRecoverySource<TSnapshot> =
  | { state: 'absent' }
  | { state: 'clean'; snapshot: TSnapshot }
  | { state: 'dirty'; candidate: TSnapshot | null };

export class InternalStorageFallbackUnsafeError extends Error {
  constructor(
    readonly replicaPath: string,
    reason: string
  ) {
    super(`Internal storage JSON fallback is unsafe: ${reason}`);
    this.name = 'InternalStorageFallbackUnsafeError';
  }
}

/**
 * Filesystem fence for the SQLite -> JSON compatibility replica. A dirty
 * envelope is written before the primary mutation/import begins; only a full
 * canonical snapshot may replace it with clean. This intentionally fails
 * closed after a crash in the SQLite-commit -> JSON-replica window.
 */
export class InternalStorageJsonReplica<TSnapshot> {
  constructor(
    private readonly getPath: (teamName: string) => string,
    private readonly isSnapshot: (value: unknown, teamName: string) => value is TSnapshot
  ) {}

  async markDirty(teamName: string): Promise<void> {
    await this.write(teamName, {
      schemaVersion: 1,
      state: 'dirty',
      updatedAt: new Date().toISOString(),
    });
  }

  /** Caller owns lifecycle/backend locks and has validated candidate ownership before this write. */
  async markDirtyWithRecoveryCandidate(
    teamName: string,
    incarnation: string,
    candidate: TSnapshot
  ): Promise<void> {
    this.validateIncarnation(teamName, incarnation);
    if (!this.isSnapshot(candidate, teamName)) {
      throw new InternalStorageFallbackUnsafeError(
        this.getPath(teamName),
        'recovery candidate is invalid'
      );
    }
    await this.write(teamName, {
      schemaVersion: 1,
      state: 'dirty',
      updatedAt: new Date().toISOString(),
      incarnation,
      snapshot: candidate,
    });
  }

  /** Evidence only. Dirty candidates never authorize fallback or establish primary continuity. */
  async readForAuthorityPreparation(
    teamName: string,
    incarnation: string
  ): Promise<InternalStorageReplicaRecoverySource<TSnapshot>> {
    this.validateIncarnation(teamName, incarnation);
    const envelope = await this.readEnvelope(teamName, false);
    if (!envelope) return { state: 'absent' };
    if ('incarnation' in envelope && envelope.incarnation !== incarnation) {
      throw new InternalStorageFallbackUnsafeError(
        this.getPath(teamName),
        'replica incarnation mismatch'
      );
    }
    if (envelope.state === 'dirty' && !('snapshot' in envelope)) {
      return { state: 'dirty', candidate: null };
    }
    if (!this.isSnapshot(envelope.snapshot, teamName)) {
      throw new InternalStorageFallbackUnsafeError(
        this.getPath(teamName),
        'replica snapshot is invalid'
      );
    }
    // Legacy dirty payloads have no trusted binding; preserve bytes without offering them for merge.
    if (envelope.state === 'dirty' && envelope.incarnation === undefined) {
      return { state: 'dirty', candidate: null };
    }
    return envelope.state === 'clean'
      ? { state: 'clean', snapshot: envelope.snapshot }
      : { state: 'dirty', candidate: envelope.snapshot };
  }

  private validateIncarnation(teamName: string, incarnation: string): void {
    if (!incarnation.trim() || incarnation !== incarnation.trim()) {
      throw new InternalStorageFallbackUnsafeError(this.getPath(teamName), 'invalid incarnation');
    }
  }

  async writeClean(teamName: string, snapshot: TSnapshot, incarnation?: string): Promise<void> {
    if (incarnation !== undefined) this.validateIncarnation(teamName, incarnation);
    await this.write(teamName, {
      schemaVersion: 1,
      state: 'clean',
      updatedAt: new Date().toISOString(),
      snapshot,
      ...(incarnation === undefined ? {} : { incarnation }),
    });
  }

  async readClean(teamName: string, required: boolean): Promise<TSnapshot | null> {
    return this.read(teamName, required, false);
  }

  /**
   * Reads the last clean snapshot before a primary session starts. A dirty
   * fence blocks JSON fallback, but it must not permanently block the SQLite
   * primary that can rebuild and republish its canonical state after a crash.
   */
  async readForPrimary(
    teamName: string,
    allowDirtyPrimaryRecovery = true
  ): Promise<TSnapshot | null> {
    return this.read(teamName, false, allowDirtyPrimaryRecovery);
  }

  private async read(
    teamName: string,
    required: boolean,
    allowDirtyPrimaryRecovery: boolean
  ): Promise<TSnapshot | null> {
    const replicaPath = this.getPath(teamName);
    const parsed = await this.readEnvelope(teamName, required);
    if (!parsed) return null;
    if (parsed.state !== 'clean') {
      if (allowDirtyPrimaryRecovery) return null;
      throw new InternalStorageFallbackUnsafeError(replicaPath, 'last SQLite publication is dirty');
    }
    if (!this.isSnapshot(parsed.snapshot, teamName)) {
      throw new InternalStorageFallbackUnsafeError(
        replicaPath,
        'clean replica snapshot is invalid'
      );
    }
    return parsed.snapshot;
  }

  private async readEnvelope(
    teamName: string,
    required: boolean
  ): Promise<InternalStorageJsonReplicaEnvelope<unknown> | null> {
    const replicaPath = this.getPath(teamName);
    let raw: string;
    try {
      raw = await readFile(replicaPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) {
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InternalStorageFallbackUnsafeError(replicaPath, 'replica is missing');
      }
      throw new InternalStorageFallbackUnsafeError(replicaPath, String(error));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InternalStorageFallbackUnsafeError(
        replicaPath,
        `replica is malformed: ${String(error)}`
      );
    }
    if (!isEnvelope(parsed)) {
      throw new InternalStorageFallbackUnsafeError(replicaPath, 'replica envelope is invalid');
    }
    return parsed;
  }

  private async write(
    teamName: string,
    envelope: InternalStorageJsonReplicaEnvelope<TSnapshot>
  ): Promise<void> {
    const replicaPath = this.getPath(teamName);
    const replicaDirectory = dirname(replicaPath);
    const firstCreatedDirectory = await mkdir(replicaDirectory, { recursive: true });
    if (firstCreatedDirectory) {
      await syncDirectoryDurably(dirname(firstCreatedDirectory));
    }
    await atomicWriteAsync(replicaPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      durability: 'strict',
      syncDirectory: true,
    });
  }
}

function isEnvelope(value: unknown): value is InternalStorageJsonReplicaEnvelope<unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    (record.state === 'dirty' || record.state === 'clean') &&
    typeof record.updatedAt === 'string'
  );
}
