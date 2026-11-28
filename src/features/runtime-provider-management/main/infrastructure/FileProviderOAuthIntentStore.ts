import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  type SecretFingerprintKdf,
  secretFingerprintKdfSchema,
} from '@agent-teams/legacy-agent-host/management/secret-fingerprint';
import { atomicCreateAsync } from '@main/utils/atomicWrite';

export interface ProviderOAuthIntent {
  schemaVersion: 1;
  runtimeId?: 'opencode' | 'claude';
  operationId: string;
  targetId: string;
  providerId: string;
  methodIndex: number;
  authOptionId: string;
  displayName: string;
  fingerprint: string;
  fingerprintKdf?: SecretFingerprintKdf;
}
export interface ProviderOAuthIntentStore {
  read(operationId: string): Promise<ProviderOAuthIntent | null>;
  create(intent: ProviderOAuthIntent): Promise<boolean>;
}
export const validOAuthOperationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
function capture(value: unknown): ProviderOAuthIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OAuth intent unavailable');
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    (record.runtimeId !== undefined &&
      record.runtimeId !== 'opencode' &&
      record.runtimeId !== 'claude') ||
    !validOAuthOperationId(record.operationId) ||
    ![record.targetId, record.fingerprint].every(
      (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ) ||
    ![record.providerId, record.authOptionId, record.displayName].every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 2048 &&
        !value.includes('\0')
    ) ||
    !Number.isSafeInteger(record.methodIndex) ||
    Number(record.methodIndex) < 0 ||
    Number(record.methodIndex) > 10000 ||
    Object.keys(record).some(
      (key) =>
        ![
          'schemaVersion',
          'runtimeId',
          'operationId',
          'targetId',
          'providerId',
          'methodIndex',
          'authOptionId',
          'displayName',
          'fingerprint',
          'fingerprintKdf',
        ].includes(key)
    )
  )
    throw new Error('OAuth intent unavailable');
  const fingerprintKdf =
    record.fingerprintKdf === undefined
      ? undefined
      : Object.freeze(secretFingerprintKdfSchema.parse(record.fingerprintKdf));
  return Object.freeze({
    ...record,
    ...(fingerprintKdf === undefined ? {} : { fingerprintKdf }),
  }) as unknown as ProviderOAuthIntent;
}

// Atomic publication can unlink a temporary hardlink while this original is being read.
function sameIntentFile(original: BigIntStats, current: BigIntStats): boolean {
  return (
    current.isFile() &&
    !current.isSymbolicLink() &&
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.size === original.size &&
    current.mtimeNs === original.mtimeNs &&
    (process.platform === 'win32' || (current.mode & 0o077n) === 0n)
  );
}

/** Immutable original routing only. Fields, codes, credentials and browser URLs are never stored. */
export class FileProviderOAuthIntentStore implements ProviderOAuthIntentStore {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new Error('OAuth intent directory invalid');
  }
  private path(operationId: string): string {
    if (!validOAuthOperationId(operationId)) throw new Error('OAuth intent invalid');
    return join(this.directory, createHash('sha256').update(operationId).digest('hex') + '.json');
  }
  async read(operationId: string): Promise<ProviderOAuthIntent | null> {
    let observed = false;
    try {
      const path = this.path(operationId);
      const original = await lstat(path, { bigint: true });
      observed = true;
      if (
        !original.isFile() ||
        original.isSymbolicLink() ||
        original.size < 0n ||
        original.size > 16384n ||
        (process.platform !== 'win32' && (original.mode & 0o077n) !== 0n)
      )
        throw new Error('OAuth intent unavailable');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!sameIntentFile(original, await file.stat({ bigint: true })))
          throw new Error('OAuth intent unavailable');
        const bytes = Buffer.alloc(16385);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (
          length > 16384 ||
          BigInt(length) !== original.size ||
          !sameIntentFile(original, after) ||
          !sameIntentFile(original, named)
        )
          throw new Error('OAuth intent unavailable');
        const record = capture(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
        );
        if (record.operationId !== operationId) throw new Error('OAuth intent unavailable');
        return record;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!observed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('OAuth intent unavailable');
    }
  }
  async create(intent: ProviderOAuthIntent): Promise<boolean> {
    const record = capture(intent);
    try {
      await atomicCreateAsync(this.path(record.operationId), JSON.stringify(record) + '\n', {
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new Error('OAuth intent unavailable');
    }
  }
}
