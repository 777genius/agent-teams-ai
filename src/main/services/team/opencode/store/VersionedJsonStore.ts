import { promises as fs } from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { withFileLock } from '../../fileLock';

export interface VersionedJsonStoreEnvelope<TData> {
  schemaVersion: number;
  updatedAt: string;
  data: TData;
}

export type VersionedJsonStoreReadStatus = 'missing' | 'loaded';

export type VersionedJsonStoreFailureReason =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'invalid_data'
  | 'future_schema';

export type VersionedJsonStoreReadResult<TData> =
  | {
      ok: true;
      status: VersionedJsonStoreReadStatus;
      data: TData;
      envelope: VersionedJsonStoreEnvelope<TData> | null;
    }
  | {
      ok: false;
      reason: VersionedJsonStoreFailureReason;
      message: string;
      quarantinePath: string | null;
    };

export interface VersionedJsonStoreUpdateResult<TData> {
  changed: boolean;
  data: TData;
  envelope: VersionedJsonStoreEnvelope<TData>;
}

export interface VersionedJsonStoreOptions<TData> {
  filePath: string;
  schemaVersion: number;
  defaultData: () => TData;
  validate: (value: unknown) => TData;
  clock?: () => Date;
  quarantineDir?: string;
}

export class VersionedJsonStoreError extends Error {
  constructor(
    message: string,
    readonly reason: VersionedJsonStoreFailureReason,
    readonly quarantinePath: string | null
  ) {
    super(message);
    this.name = 'VersionedJsonStoreError';
  }
}

export class VersionedJsonStore<TData> {
  private readonly filePath: string;
  private readonly schemaVersion: number;
  private readonly defaultData: () => TData;
  private readonly validate: (value: unknown) => TData;
  private readonly clock: () => Date;
  private readonly quarantineDir: string | null;

  constructor(options: VersionedJsonStoreOptions<TData>) {
    this.filePath = options.filePath;
    this.schemaVersion = options.schemaVersion;
    this.defaultData = options.defaultData;
    this.validate = options.validate;
    this.clock = options.clock ?? (() => new Date());
    this.quarantineDir = options.quarantineDir ?? null;
  }

  async read(): Promise<VersionedJsonStoreReadResult<TData>> {
    return this.readUnlocked();
  }

  async updateLocked(
    updater: (current: TData) => TData | Promise<TData>
  ): Promise<VersionedJsonStoreUpdateResult<TData>> {
    return withFileLock(this.filePath, async () => {
      const current = await this.readUnlocked();
      if (!current.ok) {
        throw new VersionedJsonStoreError(current.message, current.reason, current.quarantinePath);
      }

      const nextData = await updater(cloneJson(current.data));
      const validatedNextData = this.validate(nextData);
      const currentJson = stableJsonStringify(current.data);
      const nextJson = stableJsonStringify(validatedNextData);
      const changed = current.status === 'missing' || currentJson !== nextJson;
      const envelope: VersionedJsonStoreEnvelope<TData> = {
        schemaVersion: this.schemaVersion,
        updatedAt: changed
          ? this.clock().toISOString()
          : (current.envelope?.updatedAt ?? this.clock().toISOString()),
        data: changed ? validatedNextData : current.data,
      };

      if (changed) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await atomicWriteAsync(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
      }

      return {
        changed,
        data: envelope.data,
        envelope,
      };
    });
  }

  private async readUnlocked(): Promise<VersionedJsonStoreReadResult<TData>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const data = this.validate(this.defaultData());
        return {
          ok: true,
          status: 'missing',
          data,
          envelope: null,
        };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const quarantinePath = await this.quarantine(raw, 'invalid_json');
      return {
        ok: false,
        reason: 'invalid_json',
        message: `Invalid JSON in versioned store ${this.filePath}: ${stringifyError(error)}`,
        quarantinePath,
      };
    }

    const envelopeResult = this.normalizeEnvelope(parsed);
    if (!envelopeResult.ok) {
      const quarantinePath = await this.quarantine(raw, envelopeResult.reason);
      return {
        ok: false,
        reason: envelopeResult.reason,
        message: envelopeResult.message,
        quarantinePath,
      };
    }

    if (envelopeResult.envelope.schemaVersion > this.schemaVersion) {
      const quarantinePath = await this.quarantine(raw, 'future_schema');
      return {
        ok: false,
        reason: 'future_schema',
        message: `Future schema ${envelopeResult.envelope.schemaVersion} in ${this.filePath}; supported ${this.schemaVersion}`,
        quarantinePath,
      };
    }

    try {
      const data = this.validate(envelopeResult.envelope.data);
      return {
        ok: true,
        status: 'loaded',
        data,
        envelope: {
          schemaVersion: envelopeResult.envelope.schemaVersion,
          updatedAt: envelopeResult.envelope.updatedAt,
          data,
        },
      };
    } catch (error) {
      const quarantinePath = await this.quarantine(raw, 'invalid_data');
      return {
        ok: false,
        reason: 'invalid_data',
        message: `Invalid data in versioned store ${this.filePath}: ${stringifyError(error)}`,
        quarantinePath,
      };
    }
  }

  private normalizeEnvelope(
    value: unknown
  ):
    | { ok: true; envelope: VersionedJsonStoreEnvelope<unknown> }
    | { ok: false; reason: VersionedJsonStoreFailureReason; message: string } {
    if (!isRecord(value)) {
      return {
        ok: false,
        reason: 'invalid_envelope',
        message: `Versioned store ${this.filePath} must contain a JSON object`,
      };
    }

    const schemaVersion = value.schemaVersion;
    if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
      return {
        ok: false,
        reason: 'invalid_envelope',
        message: `Versioned store ${this.filePath} has invalid schemaVersion`,
      };
    }

    if (typeof value.updatedAt !== 'string' || !value.updatedAt.trim()) {
      return {
        ok: false,
        reason: 'invalid_envelope',
        message: `Versioned store ${this.filePath} has invalid updatedAt`,
      };
    }

    if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
      return {
        ok: false,
        reason: 'invalid_envelope',
        message: `Versioned store ${this.filePath} is missing data`,
      };
    }

    return {
      ok: true,
      envelope: {
        schemaVersion: schemaVersion as number,
        updatedAt: value.updatedAt,
        data: value.data,
      },
    };
  }

  private async quarantine(
    raw: string,
    reason: VersionedJsonStoreFailureReason
  ): Promise<string | null> {
    const dir = this.quarantineDir ?? path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);
    const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = path.join(dir, `${baseName}.${reason}.${stamp}.quarantine`);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(quarantinePath, raw, 'utf8');
      return quarantinePath;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

function normalizeStableJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeStableJson);
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) {
      output[key] = normalizeStableJson(nested);
    }
  }
  return output;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
