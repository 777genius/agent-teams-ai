import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { importRequestSchema } from './contracts.js';
import { plainImportAncestors, readImportBytes, validateStoppedSnapshot } from './snapshot.js';
import type { StoppedTeamImportRequest, StoppedTeamSnapshot } from './contracts.js';

export interface StoppedSnapshotAuthority {
  root: string;
  ownerId: string;
  profileId: string;
  principalId: string;
  contextIds: readonly string[];
  assertCurrent(): void;
}
const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const hold = (): never => {
  throw new TeamOwnerError('hold');
};

/** Private immutable transfer artifact, outside RPC frames. Never accepts a caller path. */
export class FileStoppedSnapshotResolver {
  private readonly directory: string;
  private readonly authority: StoppedSnapshotAuthority;
  constructor(authority: StoppedSnapshotAuthority) {
    this.authority = { ...authority, contextIds: [...authority.contextIds] };
    plainImportAncestors(authority.root);
    this.directory = join(authority.root, '.host-team-registry', 'snapshots');
  }
  private key(request: StoppedTeamImportRequest) {
    this.authority.assertCurrent();
    if (!this.authority.contextIds.includes(request.contextId))
      throw new TeamOwnerError('forbidden');
    return {
      ownerId: this.authority.ownerId,
      profileId: this.authority.profileId,
      principalId: this.authority.principalId,
      contextId: request.contextId,
      sourceId: request.sourceId,
      snapshotDigest: request.snapshotDigest,
    };
  }
  private path(request: StoppedTeamImportRequest): string {
    return join(this.directory, `${digest(this.key(request))}.json`);
  }
  read(raw: unknown): StoppedTeamSnapshot {
    const request = importRequestSchema.parse(raw),
      key = this.key(request);
    try {
      plainImportAncestors(this.directory);
      const record = JSON.parse(
        readImportBytes(this.path(request), MAX_ARTIFACT_BYTES).toString('utf8')
      ) as { key: unknown; snapshot: StoppedTeamSnapshot };
      if (digest(record.key) !== digest(key)) return hold();
      const snapshot = validateStoppedSnapshot(record.snapshot);
      if (
        snapshot.digest !== request.snapshotDigest ||
        snapshot.header.sourceId !== request.sourceId
      )
        return hold();
      this.authority.assertCurrent();
      return snapshot;
    } catch (error) {
      if (error instanceof TeamOwnerError) throw error;
      return hold();
    }
  }
  /** Main calls only after its actual captured source fence/census completed. No product write. */
  stage(raw: unknown, detached: StoppedTeamSnapshot): { sourceId: string; snapshotDigest: string } {
    const request = importRequestSchema.parse(raw),
      key = this.key(request),
      snapshot = validateStoppedSnapshot(detached);
    if (snapshot.digest !== request.snapshotDigest || snapshot.header.sourceId !== request.sourceId)
      return hold();
    const bytes = Buffer.from(JSON.stringify({ key, snapshot }));
    if (bytes.length > MAX_ARTIFACT_BYTES) return hold();
    for (const path of [join(this.authority.root, '.host-team-registry'), this.directory]) {
      try {
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) return hold();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.authority.assertCurrent();
        mkdirSync(path, { mode: 0o700 });
      }
      plainImportAncestors(path);
    }
    const path = this.path(request);
    try {
      const existing = readImportBytes(path, MAX_ARTIFACT_BYTES);
      if (!existing.equals(bytes)) return hold();
      return { sourceId: request.sourceId, snapshotDigest: request.snapshotDigest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (readdirSync(this.directory).length >= 256) return hold();
    const candidate = join(this.directory, `.candidate-${randomUUID()}`),
      fd = openSync(candidate, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    this.authority.assertCurrent();
    try {
      linkSync(candidate, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !readImportBytes(path, MAX_ARTIFACT_BYTES).equals(bytes)
      )
        throw error;
    } finally {
      unlinkSync(candidate);
    }
    if (
      createHash('sha256').update(readImportBytes(path, MAX_ARTIFACT_BYTES)).digest('hex') !==
      createHash('sha256').update(bytes).digest('hex')
    )
      return hold();
    return { sourceId: request.sourceId, snapshotDigest: request.snapshotDigest };
  }
}
