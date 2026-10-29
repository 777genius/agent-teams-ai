import { validateContextEpochs } from '../../runtime/inputPreparation.js';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, resolve } from 'node:path';

import { RuntimeOwnerError } from '../../runtime/contracts.js';
import type {
  RuntimeBinding,
  RuntimeSessionRecord,
  RuntimeStore,
  RuntimeTransaction,
} from '../../runtime/contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../../runtime/identity.js';
import { FileCheckpointStorage } from './FileCheckpointStorage.js';
import { FileRuntimeEventStorage } from './FileRuntimeEventStorage.js';
import type {
  RuntimeActivityLimits,
  RuntimeActivityRecord,
  RuntimeEventStorage,
} from '../../runtime/activityContracts.js';
import { checkpointFingerprint } from '../../runtime/checkpointIdentity.js';
import type { CheckpointPayload, CheckpointStorage } from '../../runtime/checkpointContracts.js';

const require = createRequire(import.meta.url);
const locks = require('agent-teams-controller/src/internal/fileLock.js') as {
  withFileLockSync<T>(scope: string, action: () => T): T;
};
const atomic = require('agent-teams-controller/src/internal/atomicFile.js') as {
  writeJsonFileSync(path: string, value: unknown): void;
};

function validate(record: RuntimeSessionRecord): void {
  const invalid = (): never => {
    throw new RuntimeOwnerError('hold');
  };
  if (
    !record ||
    typeof record !== 'object' ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.inputs) ||
    !Array.isArray(record.interactions) ||
    !['unopened', 'opening', 'allocated', 'closing', 'closed', 'held'].includes(record.phase) ||
    !['owned', 'released', 'unknown'].includes(record.custody) ||
    typeof record.sealed !== 'boolean' ||
    typeof record.nativeReady !== 'boolean' ||
    typeof record.hostIncarnation !== 'string' ||
    !record.hostIncarnation ||
    typeof record.profileId !== 'string' ||
    !record.profileId
  )
    invalid();
  const bindingKey = runtimeDigest(normalizeBinding(record.binding));
  if (record.config === null) {
    if (record.openFingerprint !== null || !['unopened', 'closed'].includes(record.phase))
      invalid();
  } else {
    const config = record.config;
    if (
      !config ||
      [config.tenantId, config.projectId, config.sessionId, config.configRevision].some(
        (value) => typeof value !== 'string' || !value
      ) ||
      !Number.isSafeInteger(config.generation) ||
      !Array.isArray(config.requiredCapabilities) ||
      config.requiredCapabilities.some((value) => typeof value !== 'string') ||
      runtimeDigest({ profileId: record.profileId, config }) !== record.openFingerprint
    )
      invalid();
  }
  validateContextEpochs(record);
  const inputIds = new Set<string>();
  const operations = new Set<string>();
  for (const input of record.inputs) {
    if (
      !input ||
      !input.intent ||
      typeof input.intent.content !== 'string' ||
      typeof input.intent.inputId !== 'string' ||
      !input.intent.inputId ||
      input.intent.inputId !== input.intent.deliveryId ||
      typeof input.intent.messageId !== 'string' ||
      !input.intent.messageId ||
      typeof input.operationRef !== 'string' ||
      !input.operationRef ||
      ![
        'admitted',
        'claimed',
        'consumed',
        'terminal',
        'cancelled',
        'rejected',
        'not-sent',
        'unknown',
      ].includes(input.phase) ||
      (input.phase === 'terminal' &&
        !['succeeded', 'failed', 'cancelled'].includes(input.terminal ?? '')) ||
      runtimeDigest(normalizeBinding(input.intent.binding)) !== bindingKey ||
      deliveryFingerprint(input.intent) !== input.fingerprint ||
      inputIds.has(input.intent.inputId) ||
      operations.has(input.operationRef)
    )
      invalid();
    inputIds.add(input.intent.inputId);
    operations.add(input.operationRef);
  }
  for (const interaction of record.interactions) {
    if (
      !interaction ||
      typeof interaction.interactionRef !== 'string' ||
      !interaction.interactionRef ||
      !inputIds.has(interaction.inputId) ||
      !operations.has(interaction.operationRef) ||
      !['permission', 'question'].includes(interaction.kind) ||
      !Number.isSafeInteger(interaction.expiresAt) ||
      !['pending', 'responding', 'resolved', 'unknown'].includes(interaction.phase)
    )
      invalid();
  }
  if (
    record.control &&
    (!inputIds.has(record.control.inputId) ||
      !operations.has(record.control.operationRef) ||
      !['pending', 'unknown'].includes(record.control.phase))
  )
    invalid();
  if (
    record.activitySequence !== undefined &&
    (!Number.isSafeInteger(record.activitySequence) || record.activitySequence < 0)
  )
    invalid();
  if (record.closeClaimed !== undefined && typeof record.closeClaimed !== 'boolean') invalid();
  if (
    record.nativeReady &&
    (record.phase !== 'allocated' || record.custody !== 'owned' || !record.sessionRef)
  )
    invalid();
  if (record.checkpoints !== undefined) {
    if (!Array.isArray(record.checkpoints) || !record.config) invalid();
    const ids = new Set<string>();
    for (const checkpoint of record.checkpoints) {
      if (
        !checkpoint ||
        typeof checkpoint.checkpointId !== 'string' ||
        !checkpoint.checkpointId ||
        ids.has(checkpoint.checkpointId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(checkpoint.checkpointId) ||
        checkpoint.fingerprint !==
          checkpointFingerprint(
            record.binding,
            record.profileId,
            record.config!,
            checkpoint.checkpointId
          ) ||
        typeof checkpoint.hostIncarnation !== 'string' ||
        !checkpoint.hostIncarnation ||
        !['capturing', 'published', 'unsupported', 'held'].includes(checkpoint.status)
      )
        invalid();
      ids.add(checkpoint.checkpointId);
      if (
        checkpoint.status === 'published' &&
        (checkpoint.reference !==
          `cp1-${runtimeDigest({ binding: record.binding, checkpointId: checkpoint.checkpointId })}` ||
          !/^[a-f0-9]{64}$/.test(checkpoint.payloadDigest ?? '') ||
          !/^[a-f0-9]{64}$/.test(checkpoint.historyDigest ?? ''))
      )
        invalid();
      if (checkpoint.status !== 'published' && checkpoint.reference !== undefined) invalid();
    }
  }
  if (
    record.restoredFrom &&
    (record.config?.checkpointRef !== record.restoredFrom.reference ||
      !/^cp1-[a-f0-9]{64}$/.test(record.restoredFrom.reference) ||
      ['backendId', 'teamId', 'memberId'].some(
        (key) =>
          normalizeBinding(record.restoredFrom!.sourceBinding)[
            key as 'backendId' | 'teamId' | 'memberId'
          ] !== record.binding[key as 'backendId' | 'teamId' | 'memberId']
      ))
  )
    invalid();
}

/** Existing cross-process lock/atomic IO. No age-based lock takeover or power-loss claim. */
export class FileRuntimeStore implements RuntimeStore, CheckpointStorage, RuntimeEventStorage {
  private readonly directory: string;
  private readonly checkpointStorage: FileCheckpointStorage;
  private readonly eventStorage: FileRuntimeEventStorage;
  readonly activityLimits: Readonly<RuntimeActivityLimits>;
  private readonly maxStateBytes: number;
  private readonly growthLimit: number;

  constructor(
    root: string,
    limits: {
      maxStateBytes?: number;
      settlementReserveBytes?: number;
      maxCheckpointBytes?: number;
      activity?: Partial<RuntimeActivityLimits>;
    } = {}
  ) {
    this.maxStateBytes = limits.maxStateBytes ?? 16 * 1024 * 1024;
    const reserve = limits.settlementReserveBytes ?? 512 * 1024;
    if (
      !Number.isSafeInteger(this.maxStateBytes) ||
      !Number.isSafeInteger(reserve) ||
      reserve < 1024 ||
      reserve >= this.maxStateBytes
    )
      throw new RuntimeOwnerError('invalid');
    this.growthLimit = this.maxStateBytes - reserve;
    if (!isAbsolute(root) || resolve(root) !== root) throw new RuntimeOwnerError('invalid');
    let part = parse(root).root;
    for (const segment of root.slice(part.length).split('/')) {
      part = join(part, segment);
      try {
        const stat = lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeOwnerError('invalid');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(part);
      }
    }
    if (realpathSync(root) !== root) throw new RuntimeOwnerError('invalid');
    this.directory = join(root, 'runtime-sessions');
    this.ensureDirectory(this.directory);
    this.checkpointStorage = new FileCheckpointStorage(root, limits.maxCheckpointBytes);
    this.eventStorage = new FileRuntimeEventStorage(root, limits.activity);
    this.activityLimits = this.eventStorage.activityLimits;
  }

  fenced<T>(rawBinding: RuntimeBinding, action: (transaction: RuntimeTransaction) => T): T {
    const binding = normalizeBinding(rawBinding);
    const member = {
      backendId: binding.backendId,
      teamId: binding.teamId,
      memberId: binding.memberId,
    };
    const directory = join(this.directory, runtimeDigest(member));
    this.ensureDirectory(this.directory);
    this.ensureDirectory(directory);
    const path = join(directory, `${runtimeDigest(binding)}.json`);
    const read = (file: string): RuntimeSessionRecord | undefined => {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxStateBytes)
          throw new RuntimeOwnerError('hold');
        const record = JSON.parse(readFileSync(file, 'utf8')) as RuntimeSessionRecord;
        validate(record);
        const actual = normalizeBinding(record.binding);
        if (
          actual.backendId !== member.backendId ||
          actual.teamId !== member.teamId ||
          actual.memberId !== member.memberId ||
          file !== join(directory, `${runtimeDigest(actual)}.json`)
        )
          throw new RuntimeOwnerError('hold');
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new RuntimeOwnerError('hold');
      }
    };
    return locks.withFileLockSync(join(directory, 'member'), () =>
      action({
        get: () => read(path),
        siblings: () =>
          readdirSync(directory)
            .filter((name) => name.endsWith('.json'))
            .map((name) => {
              const record = read(join(directory, name));
              if (!record) throw new RuntimeOwnerError('hold');
              return record;
            }),
        put: (record, purpose) => {
          validate(record);
          if (runtimeDigest(normalizeBinding(record.binding)) !== runtimeDigest(binding)) {
            throw new RuntimeOwnerError('conflict');
          }
          const bytes = Buffer.byteLength(JSON.stringify(record, null, 2));
          if (bytes > (purpose === 'growth' ? this.growthLimit : this.maxStateBytes))
            throw new RuntimeOwnerError(purpose === 'growth' ? 'busy' : 'hold');
          atomic.writeJsonFileSync(path, record);
        },
      })
    );
  }

  readActivity(binding: RuntimeBinding): RuntimeActivityRecord | undefined {
    return this.eventStorage.readActivity(binding);
  }
  writeActivity(record: RuntimeActivityRecord): void {
    this.eventStorage.writeActivity(record);
  }

  writeCheckpoint(payload: CheckpointPayload): void {
    this.checkpointStorage.writeCheckpoint(payload);
  }
  readCheckpointPayload(reference: string): CheckpointPayload {
    return this.checkpointStorage.readCheckpointPayload(reference);
  }

  private ensureDirectory(path: string): void {
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeOwnerError('hold');
  }
}
