import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { RuntimeOwnerError } from '../../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../../runtime/identity.js';
import { normalizeOpenConfig } from '../../runtime/sessionState.js';
import {
  checkpointFingerprint,
  checkpointJson,
  checkpointPayloadDigest,
} from '../../runtime/checkpointIdentity.js';
import type { CheckpointPayload, CheckpointStorage } from '../../runtime/checkpointContracts.js';

const atomic = createRequire(import.meta.url)(
  'agent-teams-controller/src/internal/atomicFile.js'
) as {
  writeJsonFileSync(path: string, value: unknown): void;
};

/** Private JSON payloads. Atomic helper offers process-crash safety, not a new fsync guarantee. */
export class FileCheckpointStorage implements CheckpointStorage {
  private readonly directory: string;
  constructor(
    root: string,
    private readonly maxBytes = 8 * 1024 * 1024
  ) {
    if (
      !isAbsolute(root) ||
      resolve(root) !== root ||
      realpathSync(root) !== root ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1024
    )
      throw new RuntimeOwnerError('invalid');
    this.directory = join(root, 'runtime-checkpoints');
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.checkDirectory();
  }

  writeCheckpoint(payload: CheckpointPayload): void {
    this.checkDirectory();
    this.validate(payload);
    if (Buffer.byteLength(JSON.stringify(payload, null, 2)) > this.maxBytes)
      throw new RuntimeOwnerError('hold');
    const path = this.path(payload.reference);
    try {
      lstatSync(path);
      if (this.readCheckpointPayload(payload.reference).digest !== payload.digest)
        throw new RuntimeOwnerError('conflict');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    atomic.writeJsonFileSync(path, payload);
  }

  readCheckpointPayload(reference: string): CheckpointPayload {
    this.checkDirectory();
    const path = this.path(reference);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes)
        throw new RuntimeOwnerError('hold');
      const payload = JSON.parse(readFileSync(path, 'utf8')) as CheckpointPayload;
      this.validate(payload);
      if (payload.reference !== reference) throw new RuntimeOwnerError('hold');
      return payload;
    } catch {
      throw new RuntimeOwnerError('hold');
    }
  }

  private validate(payload: CheckpointPayload): void {
    if (
      !payload ||
      payload.schemaVersion !== 1 ||
      typeof payload.checkpointId !== 'string' ||
      !payload.checkpointId ||
      typeof payload.fingerprint !== 'string' ||
      typeof payload.profileId !== 'string' ||
      !payload.profileId ||
      typeof payload.historyDigest !== 'string' ||
      !Array.isArray(payload.completedOperations) ||
      typeof payload.sourceSessionRef !== 'string' ||
      !payload.sourceSessionRef ||
      payload.sourceSessionRef.length > 1024 ||
      !Object.hasOwn(payload, 'opaque')
    )
      throw new RuntimeOwnerError('hold');
    const binding = normalizeBinding(payload.sourceBinding);
    normalizeOpenConfig(payload.sourceConfig, true);
    checkpointJson(payload.opaque);
    if (
      payload.fingerprint !==
        checkpointFingerprint(
          binding,
          payload.profileId,
          payload.sourceConfig,
          payload.checkpointId
        ) ||
      payload.historyDigest !==
        runtimeDigest({
          baseline: payload.sourceConfig.checkpointRef ?? null,
          operations: payload.completedOperations,
        })
    )
      throw new RuntimeOwnerError('hold');
    if (
      payload.reference !== `cp1-${runtimeDigest({ binding, checkpointId: payload.checkpointId })}`
    )
      throw new RuntimeOwnerError('hold');
    const { digest, ...body } = payload;
    if (typeof digest !== 'string' || checkpointPayloadDigest(body) !== digest)
      throw new RuntimeOwnerError('hold');
    for (const operation of payload.completedOperations) {
      if (
        !operation ||
        [operation.inputId, operation.operationRef, operation.fingerprint].some(
          (value) => typeof value !== 'string' || !value
        ) ||
        !['succeeded', 'failed', 'cancelled'].includes(operation.outcome)
      )
        throw new RuntimeOwnerError('hold');
    }
  }
  private path(reference: string): string {
    if (!/^cp1-[a-f0-9]{64}$/.test(reference)) throw new RuntimeOwnerError('invalid');
    return join(this.directory, `${reference}.json`);
  }
  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeOwnerError('hold');
  }
}
