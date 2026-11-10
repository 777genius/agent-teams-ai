import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { RuntimeOwnerError } from '../../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../../runtime/identity.js';
import { DEFAULT_ACTIVITY_LIMITS } from '../../runtime/activityContracts.js';
import type { RuntimeBinding } from '../../runtime/contracts.js';
import type {
  RuntimeActivityLimits,
  RuntimeActivityRecord,
  RuntimeEventStorage,
} from '../../runtime/activityContracts.js';

const atomic = createRequire(import.meta.url)(
  'agent-teams-controller/src/internal/atomicFile.js'
) as { writeJsonFileSync(path: string, value: unknown): void };
/** Bounded derived observations, separate from authoritative session/control storage. Caller holds member fence. */
export class FileRuntimeEventStorage implements RuntimeEventStorage {
  readonly activityLimits: Readonly<RuntimeActivityLimits>;
  private readonly directory: string;
  constructor(root: string, limits: Partial<RuntimeActivityLimits> = {}) {
    this.activityLimits = Object.freeze({ ...DEFAULT_ACTIVITY_LIMITS, ...limits });
    const value = this.activityLimits;
    if (
      !isAbsolute(root) ||
      resolve(root) !== root ||
      realpathSync(root) !== root ||
      !Number.isSafeInteger(value.maxBytes) ||
      value.maxBytes < 1024 ||
      value.maxBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(value.maxEvents) ||
      value.maxEvents < 1 ||
      value.maxEvents > 4096 ||
      !Number.isSafeInteger(value.maxEventBytes) ||
      value.maxEventBytes < 256 ||
      value.maxEventBytes > value.maxBytes / 2 ||
      value.maxEventBytes > 64 * 1024
    )
      throw new RuntimeOwnerError('invalid');
    this.directory = join(root, 'runtime-events');
    this.checkDirectory(true);
  }
  readActivity(raw: RuntimeBinding): RuntimeActivityRecord | undefined {
    const binding = normalizeBinding(raw);
    this.checkDirectory();
    const path = this.path(binding);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.activityLimits.maxBytes)
        throw new RuntimeOwnerError('hold');
      const record = JSON.parse(readFileSync(path, 'utf8')) as RuntimeActivityRecord;
      this.validate(record);
      if (runtimeDigest(record.binding) !== runtimeDigest(binding))
        throw new RuntimeOwnerError('hold');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RuntimeOwnerError('hold');
    }
  }
  writeActivity(record: RuntimeActivityRecord): void {
    this.checkDirectory();
    this.validate(record);
    atomic.writeJsonFileSync(this.path(record.binding), record);
  }
  private validate(record: RuntimeActivityRecord): void {
    const invalid = (): never => {
      throw new RuntimeOwnerError('hold');
    };
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 0 ||
      typeof record.writerIncarnation !== 'string' ||
      !record.writerIncarnation ||
      !/^[a-f0-9]{64}$/.test(record.stateDigest) ||
      !Array.isArray(record.events) ||
      record.events.length > this.activityLimits.maxEvents ||
      Buffer.byteLength(JSON.stringify(record, null, 2)) > this.activityLimits.maxBytes
    )
      invalid();
    const { digest, ...body } = record;
    if (typeof digest !== 'string' || runtimeDigest(body) !== digest) invalid();
    const key = runtimeDigest(normalizeBinding(record.binding));
    let sequence = 0;
    for (const event of record.events) {
      if (
        !event ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= sequence ||
        event.sequence > record.sequence ||
        event.eventId !== `${key}:${event.sequence}` ||
        (event.observedAt !== undefined && (typeof event.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(event.observedAt) || !Number.isFinite(Date.parse(event.observedAt)))) ||
        !event.data ||
        typeof event.data !== 'object' ||
        Array.isArray(event.data) ||
        typeof event.data.kind !== 'string' ||
        (event.inputId === undefined) !== (event.operationRef === undefined) ||
        (event.inputId !== undefined &&
          (typeof event.inputId !== 'string' ||
            !event.inputId ||
            event.inputId.length > 256 ||
            typeof event.operationRef !== 'string' ||
            !event.operationRef ||
            event.operationRef.length > 256)) ||
        Buffer.byteLength(JSON.stringify(event)) > this.activityLimits.maxEventBytes
      )
        invalid();
      sequence = event.sequence;
    }
    if (record.events.length && sequence !== record.sequence) invalid();
  }
  private path(binding: RuntimeBinding): string {
    return join(this.directory, `${runtimeDigest(binding)}.json`);
  }
  private checkDirectory(create = false): void {
    if (create) {
      try {
        mkdirSync(this.directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeOwnerError('hold');
  }
}
