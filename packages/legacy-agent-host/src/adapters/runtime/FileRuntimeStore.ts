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
  if (record.closeClaimed !== undefined && typeof record.closeClaimed !== 'boolean') invalid();
  if (
    record.nativeReady &&
    (record.phase !== 'allocated' || record.custody !== 'owned' || !record.sessionRef)
  )
    invalid();
}

/** Existing cross-process lock/atomic IO. No age-based lock takeover or power-loss claim. */
export class FileRuntimeStore implements RuntimeStore {
  private readonly directory: string;

  constructor(root: string) {
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
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
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
        put: (record) => {
          validate(record);
          if (runtimeDigest(normalizeBinding(record.binding)) !== runtimeDigest(binding)) {
            throw new RuntimeOwnerError('conflict');
          }
          if (Buffer.byteLength(JSON.stringify(record, null, 2)) > 16 * 1024 * 1024)
            throw new RuntimeOwnerError('hold');
          atomic.writeJsonFileSync(path, record);
        },
      })
    );
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
