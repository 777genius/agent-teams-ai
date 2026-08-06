import { createHash, randomUUID } from 'node:crypto';

// eslint-disable-next-line no-restricted-imports -- Ledger mechanics use the feature public contract.
import {
  type HostedTaskMutationCommand,
  type HostedTaskMutationCommittedReceipt,
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskMutationCommand,
} from '@features/team-task-board/main/hosted';
import { atomicCreateAsync } from '@main/utils/atomicWrite';
import { atomicReplaceFileIfUnchangedAsync } from '@main/utils/durablePathOperations';
import { parseRevision, parseTeamId } from '@shared/contracts/hosted';

import {
  descriptorChildPath,
  hasExactHostedTaskBoardRecordKeys,
  HostedTaskBoardDescriptorFsError,
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  type HostedTaskBoardPersistedFileStamp,
  hostedTaskBoardUtf8ByteLength,
  isHostedTaskBoardChildName,
  parseHostedTaskBoardPersistedFileStamp,
  readHostedTaskBoardFile,
  serializeHostedTaskBoardPersistedFileStamp,
} from './hostedTaskBoardDescriptorFs';

const MAX_LEDGER_ENTRIES = 256;
const LEDGER_SCHEMA_VERSION = 2;
const FENCE_SCHEMA_VERSION = 1;
const MAX_FENCE_BYTES = 4 * 1024;
export const HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES = 8 * 1024 * 1024;
export const HOSTED_TASK_BOARD_MUTATION_MAX_LEDGER_BYTES = 512 * 1024;
export const HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES = 512;

export const HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE = 'hosted-task-board-mutation-ledger.v2.json';
export const HOSTED_TASK_BOARD_MUTATION_FENCE_FILE = 'hosted-task-board-mutation.fence.v1.json';

const hasExactKeys = hasExactHostedTaskBoardRecordKeys;
export type HostedTaskBoardMutationWalParent = 'team' | 'tasks';

export interface HostedTaskBoardMutationWalDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface HostedTaskBoardMutationWalScope {
  readonly teamDirectory: HostedTaskBoardMutationWalDirectoryIdentity;
  readonly tasksDirectory: HostedTaskBoardMutationWalDirectoryIdentity;
  readonly taskDirectoryNames: readonly string[];
}

export type HostedTaskBoardMutationWalPreimage =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly text: string;
      readonly stamp: HostedTaskBoardPersistedFileStamp;
    };

export type HostedTaskBoardMutationWalGuardPreimage =
  | { readonly exists: false }
  | { readonly exists: true; readonly stamp: HostedTaskBoardPersistedFileStamp };

export type HostedTaskBoardMutationPublishKind = 'task' | 'kanban' | 'ledger';

export interface HostedTaskBoardMutationWalTarget {
  readonly kind: HostedTaskBoardMutationPublishKind;
  readonly parent: HostedTaskBoardMutationWalParent;
  readonly name: string;
  readonly maximumBytes: number;
  readonly preimage: HostedTaskBoardMutationWalPreimage;
  readonly postimage: string;
}

export interface HostedTaskBoardMutationWalGuard {
  readonly parent: HostedTaskBoardMutationWalParent;
  readonly name: string;
  readonly maximumBytes: number;
  readonly preimage: HostedTaskBoardMutationWalGuardPreimage;
}

export interface HostedTaskBoardMutationWal {
  readonly schemaVersion: 2;
  readonly phase: 'prepared' | 'terminal';
  readonly transactionId: string;
  readonly createdAtMs: number;
  readonly command: HostedTaskMutationCommand;
  readonly payloadFingerprint: string;
  readonly sourceGeneration: string;
  readonly scope: HostedTaskBoardMutationWalScope;
  readonly guards: readonly HostedTaskBoardMutationWalGuard[];
  readonly targets: readonly HostedTaskBoardMutationWalTarget[];
  readonly finalReceipt: HostedTaskMutationCommittedReceipt;
}

export interface HostedTaskBoardMutationLedgerEntry {
  readonly fingerprint: string;
  readonly commandId: string;
  readonly sourceGeneration: string;
  readonly expectedRevision: string;
  readonly receipt: HostedTaskMutationCommittedReceipt;
  readonly committedAtMs: number;
}

export interface HostedTaskBoardMutationLedger<Snapshot> {
  readonly entries: ReadonlyMap<string, HostedTaskBoardMutationLedgerEntry>;
  readonly snapshot: Snapshot | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WAL_SCHEMA_VERSION = 2;
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

function validWalName(value: unknown): value is string {
  return isHostedTaskBoardChildName(value) && value.length <= 128;
}

function parseDecimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new TypeError('hosted-task-board-mutation-wal-stamp-invalid');
  }
  return BigInt(value);
}

export function normalizeHostedTaskBoardMutationWalNames(
  value: readonly string[]
): readonly string[] {
  if (
    value.length > HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES ||
    value.some((name) => !validWalName(name)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-membership-invalid');
  }
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  if (sorted.some((name, index) => name !== value[index])) {
    throw new TypeError('hosted-task-board-mutation-wal-membership-invalid');
  }
  return Object.freeze(sorted);
}

export function hostedTaskBoardMutationStageName(
  transactionId: string,
  targetIndex: number
): string {
  if (
    !/^[0-9a-f-]{36}$/i.test(transactionId) ||
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0
  )
    throw new TypeError('hosted-task-board-mutation-wal-stage-invalid');
  return `.hosted-task-board-mutation-${transactionId}-${targetIndex}.stage`;
}

export function serializeHostedTaskBoardMutationWalDirectory(
  directory: HostedTaskBoardDirectoryDescriptor
): HostedTaskBoardMutationWalDirectoryIdentity {
  return Object.freeze({
    canonicalPath: directory.identity.canonicalPath,
    device: directory.identity.device.toString(),
    inode: directory.identity.inode.toString(),
  });
}

function parseWalDirectory(value: unknown): HostedTaskBoardMutationWalDirectoryIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['canonicalPath', 'device', 'inode']) ||
    typeof value.canonicalPath !== 'string' ||
    !value.canonicalPath.startsWith('/')
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-scope-invalid');
  }
  parseDecimal(value.device);
  parseDecimal(value.inode);
  return Object.freeze({
    canonicalPath: value.canonicalPath,
    device: value.device as string,
    inode: value.inode as string,
  });
}

function serializeWalPreimage(
  snapshot: HostedTaskBoardFileSnapshot,
  includeText: boolean
): HostedTaskBoardMutationWalPreimage | HostedTaskBoardMutationWalGuardPreimage {
  if (!snapshot.exists) return Object.freeze({ exists: false });
  const stamp = serializeHostedTaskBoardPersistedFileStamp(snapshot.stamp);
  return includeText
    ? Object.freeze({ exists: true, text: snapshot.text, stamp })
    : Object.freeze({ exists: true, stamp });
}

export const serializeHostedTaskBoardMutationWalPreimage = (
  snapshot: HostedTaskBoardFileSnapshot
): HostedTaskBoardMutationWalPreimage =>
  serializeWalPreimage(snapshot, true) as HostedTaskBoardMutationWalPreimage;

export const serializeHostedTaskBoardMutationWalGuardPreimage = (
  snapshot: HostedTaskBoardFileSnapshot
): HostedTaskBoardMutationWalGuardPreimage =>
  serializeWalPreimage(snapshot, false) as HostedTaskBoardMutationWalGuardPreimage;

function parseWalPreimage(
  value: unknown,
  includeText: boolean
): HostedTaskBoardMutationWalPreimage | HostedTaskBoardMutationWalGuardPreimage {
  const error = 'hosted-task-board-mutation-wal-preimage-invalid';
  if (!isRecord(value) || typeof value.exists !== 'boolean') {
    throw new TypeError(error);
  }
  if (value.exists === false) {
    if (!hasExactKeys(value, ['exists'])) throw new TypeError(error);
    return Object.freeze({ exists: false });
  }
  const expected = includeText ? ['exists', 'text', 'stamp'] : ['exists', 'stamp'];
  if (
    !hasExactKeys(value, expected) ||
    (includeText &&
      (typeof value.text !== 'string' || hostedTaskBoardUtf8ByteLength(value.text) < 1))
  ) {
    throw new TypeError(error);
  }
  const stamp = parseHostedTaskBoardPersistedFileStamp(value.stamp);
  return includeText
    ? Object.freeze({ exists: true, text: value.text as string, stamp })
    : Object.freeze({ exists: true, stamp });
}

function parseWalGuardPreimage(value: unknown): HostedTaskBoardMutationWalGuardPreimage {
  try {
    return parseWalPreimage(value, false) as HostedTaskBoardMutationWalGuardPreimage;
  } catch {
    throw new TypeError('hosted-task-board-mutation-wal-guard-invalid');
  }
}

function parseWalTarget(value: unknown): HostedTaskBoardMutationWalTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'parent', 'name', 'maximumBytes', 'preimage', 'postimage']) ||
    !['task', 'kanban', 'ledger'].includes(value.kind as string) ||
    (value.parent !== 'team' && value.parent !== 'tasks') ||
    !validWalName(value.name) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    (value.maximumBytes as number) < 1 ||
    (value.maximumBytes as number) > HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES ||
    typeof value.postimage !== 'string' ||
    hostedTaskBoardUtf8ByteLength(value.postimage) < 1 ||
    hostedTaskBoardUtf8ByteLength(value.postimage) > (value.maximumBytes as number)
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-target-invalid');
  }
  const preimage = parseWalPreimage(value.preimage, true) as HostedTaskBoardMutationWalPreimage;
  if (
    preimage.exists &&
    hostedTaskBoardUtf8ByteLength(preimage.text) > (value.maximumBytes as number)
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-target-invalid');
  }
  return Object.freeze({
    kind: value.kind as HostedTaskBoardMutationPublishKind,
    parent: value.parent,
    name: value.name,
    maximumBytes: value.maximumBytes as number,
    preimage,
    postimage: value.postimage,
  });
}

function parseWalGuard(value: unknown): HostedTaskBoardMutationWalGuard {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parent', 'name', 'maximumBytes', 'preimage']) ||
    (value.parent !== 'team' && value.parent !== 'tasks') ||
    !validWalName(value.name) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    (value.maximumBytes as number) < 1 ||
    (value.maximumBytes as number) > HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-guard-invalid');
  }
  return Object.freeze({
    parent: value.parent,
    name: value.name,
    maximumBytes: value.maximumBytes as number,
    preimage: parseWalGuardPreimage(value.preimage),
  });
}

export function assertHostedTaskBoardMutationWalTargetLayout(
  targets: readonly HostedTaskBoardMutationWalTarget[]
): void {
  if (targets.length < 2) {
    throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
  }
  const ledger = targets.at(-1);
  if (
    ledger === undefined ||
    ledger.kind !== 'ledger' ||
    ledger.parent !== 'team' ||
    ledger.name !== HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
  }
  let sawKanban = false;
  let previousTaskName: string | null = null;
  for (const target of targets.slice(0, -1)) {
    if (target.kind === 'task') {
      if (
        sawKanban ||
        target.parent !== 'tasks' ||
        !TASK_FILE.test(target.name) ||
        (previousTaskName !== null && previousTaskName.localeCompare(target.name) >= 0)
      ) {
        throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
      }
      previousTaskName = target.name;
      continue;
    }
    if (
      target.kind !== 'kanban' ||
      sawKanban ||
      target.parent !== 'team' ||
      target.name !== 'kanban-state.json'
    ) {
      throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
    }
    sawKanban = true;
  }
}

export function serializeHostedTaskBoardMutationWalReceipt(
  receipt: HostedTaskMutationCommittedReceipt
): HostedTaskMutationCommittedReceipt {
  return Object.freeze({
    ...receipt,
    affectedTaskIds: Object.freeze([...receipt.affectedTaskIds]),
  });
}

export function parseHostedTaskBoardMutationWal(value: unknown): HostedTaskBoardMutationWal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'phase',
      'transactionId',
      'createdAtMs',
      'command',
      'payloadFingerprint',
      'sourceGeneration',
      'scope',
      'guards',
      'targets',
      'finalReceipt',
    ]) ||
    value.schemaVersion !== WAL_SCHEMA_VERSION ||
    (value.phase !== 'prepared' && value.phase !== 'terminal') ||
    typeof value.transactionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.transactionId) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    (value.createdAtMs as number) < 0 ||
    typeof value.payloadFingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.payloadFingerprint) ||
    typeof value.sourceGeneration !== 'string' ||
    !isRecord(value.scope) ||
    !hasExactKeys(value.scope, ['teamDirectory', 'tasksDirectory', 'taskDirectoryNames']) ||
    !Array.isArray(value.guards) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 2 ||
    value.targets.length > HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES + 2
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-invalid');
  }
  const command = parseHostedTaskMutationCommand(value.command);
  if (!command.ok || command.value.expectedSourceGeneration !== value.sourceGeneration) {
    throw new TypeError('hosted-task-board-mutation-wal-command-invalid');
  }
  const receipt = normalizeHostedTaskMutationReceipt(
    value.finalReceipt,
    'committed',
    command.value.commandId,
    command.value.teamId,
    command.value.expectedSourceGeneration
  );
  if (!receipt.ok || receipt.value.outcome !== 'committed') {
    throw new TypeError('hosted-task-board-mutation-wal-receipt-invalid');
  }
  const targets = value.targets.map(parseWalTarget);
  const guards = value.guards.map(parseWalGuard);
  const targetKeys = new Set(targets.map((target) => `${target.parent}\u0000${target.name}`));
  const guardKeys = new Set(guards.map((guard) => `${guard.parent}\u0000${guard.name}`));
  if (
    targetKeys.size !== targets.length ||
    guardKeys.size !== guards.length ||
    [...guardKeys].some((key) => targetKeys.has(key)) ||
    targets.filter((target) => target.kind === 'ledger').length !== 1
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-target-invalid');
  }
  assertHostedTaskBoardMutationWalTargetLayout(targets);
  return Object.freeze({
    schemaVersion: 2,
    phase: value.phase,
    transactionId: value.transactionId,
    createdAtMs: value.createdAtMs as number,
    command: command.value,
    payloadFingerprint: value.payloadFingerprint,
    sourceGeneration: value.sourceGeneration,
    scope: Object.freeze({
      teamDirectory: parseWalDirectory(value.scope.teamDirectory),
      tasksDirectory: parseWalDirectory(value.scope.tasksDirectory),
      taskDirectoryNames: normalizeHostedTaskBoardMutationWalNames(
        value.scope.taskDirectoryNames as readonly string[]
      ),
    }),
    guards: Object.freeze(guards),
    targets: Object.freeze(targets),
    finalReceipt: serializeHostedTaskBoardMutationWalReceipt(receipt.value),
  });
}

export function serializeHostedTaskBoardMutationWal(wal: HostedTaskBoardMutationWal): string {
  const serialized = `${JSON.stringify(wal, null, 2)}\n`;
  if (hostedTaskBoardUtf8ByteLength(serialized) > HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES) {
    throw new TypeError('hosted-task-board-mutation-wal-budget-exceeded');
  }
  return serialized;
}

export const hostedTaskBoardMutationWalByteLength = hostedTaskBoardUtf8ByteLength;

export const validHostedTaskBoardMutationWalName = validWalName;

function parseReceipt(value: unknown): HostedTaskMutationCommittedReceipt {
  if (
    !isRecord(value) ||
    !Array.isArray(value.affectedTaskIds) ||
    value.affectedTaskIds.length > 100
  ) {
    throw new TypeError('hosted-task-board-mutation-ledger-receipt-invalid');
  }
  const receipt = normalizeHostedTaskMutationReceipt(
    value,
    'committed',
    parseHostedTaskCommandId(value.commandId),
    parseTeamId(value.teamId),
    parseHostedTaskBoardSourceGeneration(value.sourceGeneration)
  );
  if (!receipt.ok || receipt.value.outcome !== 'committed') {
    throw new TypeError('hosted-task-board-mutation-ledger-receipt-invalid');
  }
  return receipt.value;
}

function parseEntry(value: unknown): HostedTaskBoardMutationLedgerEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'fingerprint',
      'commandId',
      'sourceGeneration',
      'expectedRevision',
      'receipt',
      'committedAtMs',
    ]) ||
    typeof value.fingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.fingerprint) ||
    !Number.isSafeInteger(value.committedAtMs) ||
    (value.committedAtMs as number) < 0
  ) {
    throw new TypeError('hosted-task-board-mutation-ledger-entry-invalid');
  }
  const commandId = parseHostedTaskCommandId(value.commandId);
  const sourceGeneration = parseHostedTaskBoardSourceGeneration(value.sourceGeneration);
  const expectedRevision = parseRevision(value.expectedRevision);
  const receipt = parseReceipt(value.receipt);
  if (receipt.commandId !== commandId || receipt.sourceGeneration !== sourceGeneration) {
    throw new TypeError('hosted-task-board-mutation-ledger-entry-invalid');
  }
  return Object.freeze({
    fingerprint: value.fingerprint,
    commandId,
    sourceGeneration,
    expectedRevision,
    receipt,
    committedAtMs: value.committedAtMs as number,
  });
}

export function hostedTaskBoardMutationLedgerKey(
  teamId: string,
  sourceGeneration: string,
  idempotencyKey: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'hosted-task-board-idempotency-ledger/v3',
        teamId,
        sourceGeneration,
        idempotencyKey,
      }),
      'utf8'
    )
    .digest('hex');
}

export function parseHostedTaskBoardMutationLedger<Snapshot>(
  serialized: string | null,
  snapshot: Snapshot | null
): HostedTaskBoardMutationLedger<Snapshot> {
  if (serialized === null) return Object.freeze({ entries: new Map(), snapshot });
  if (hostedTaskBoardUtf8ByteLength(serialized) > HOSTED_TASK_BOARD_MUTATION_MAX_LEDGER_BYTES) {
    throw new TypeError('hosted-task-board-mutation-ledger-budget-exceeded');
  }
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'entries']) ||
    value.schemaVersion !== LEDGER_SCHEMA_VERSION ||
    !isRecord(value.entries)
  ) {
    throw new TypeError('hosted-task-board-mutation-ledger-invalid');
  }
  const entries = new Map<string, HostedTaskBoardMutationLedgerEntry>();
  for (const [key, candidate] of Object.entries(value.entries)) {
    if (!/^[a-f0-9]{64}$/.test(key) || entries.has(key)) {
      throw new TypeError('hosted-task-board-mutation-ledger-invalid');
    }
    entries.set(key, parseEntry(candidate));
  }
  if (entries.size > MAX_LEDGER_ENTRIES) {
    throw new TypeError('hosted-task-board-mutation-ledger-invalid');
  }
  return Object.freeze({ entries, snapshot });
}

export function serializeHostedTaskBoardMutationLedger(
  entries: ReadonlyMap<string, HostedTaskBoardMutationLedgerEntry>
): string {
  if (entries.size > MAX_LEDGER_ENTRIES) {
    throw new TypeError('hosted-task-board-mutation-ledger-entry-budget-exceeded');
  }
  const serializedEntries = Object.fromEntries(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        {
          fingerprint: entry.fingerprint,
          commandId: entry.commandId,
          sourceGeneration: entry.sourceGeneration,
          expectedRevision: entry.expectedRevision,
          receipt: { ...entry.receipt, affectedTaskIds: [...entry.receipt.affectedTaskIds] },
          committedAtMs: entry.committedAtMs,
        },
      ])
  );
  const serialized = `${JSON.stringify(
    { schemaVersion: LEDGER_SCHEMA_VERSION, entries: serializedEntries },
    null,
    2
  )}\n`;
  if (hostedTaskBoardUtf8ByteLength(serialized) > HOSTED_TASK_BOARD_MUTATION_MAX_LEDGER_BYTES) {
    throw new TypeError('hosted-task-board-mutation-ledger-budget-exceeded');
  }
  return serialized;
}

export function withHostedTaskBoardMutationLedgerEntry(
  ledger: HostedTaskBoardMutationLedger<unknown>,
  key: string,
  entry: HostedTaskBoardMutationLedgerEntry
): ReadonlyMap<string, HostedTaskBoardMutationLedgerEntry> {
  if (ledger.entries.has(key)) {
    throw new TypeError('hosted-task-board-mutation-ledger-write-invalid');
  }
  // Same-generation receipts survive compaction: otherwise an ABA can duplicate a durable command.
  const next = new Map(
    [...ledger.entries].filter(
      ([, candidate]) => candidate.sourceGeneration === entry.sourceGeneration
    )
  );
  next.set(key, Object.freeze(entry));
  if (next.size > MAX_LEDGER_ENTRIES) {
    throw new TypeError('hosted-task-board-mutation-ledger-entry-budget-exceeded');
  }
  serializeHostedTaskBoardMutationLedger(next);
  return next;
}

interface HostedTaskBoardMutationFenceRecord {
  readonly token: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

function fencePayload(record: HostedTaskBoardMutationFenceRecord): string {
  return `${JSON.stringify({ schemaVersion: FENCE_SCHEMA_VERSION, ...record })}\n`;
}

function parseFence(value: string): HostedTaskBoardMutationFenceRecord {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['schemaVersion', 'token', 'generation', 'expiresAtMs']) ||
    parsed.schemaVersion !== FENCE_SCHEMA_VERSION ||
    typeof parsed.token !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(parsed.token) ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    !Number.isSafeInteger(parsed.expiresAtMs) ||
    (parsed.expiresAtMs as number) < 0
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-invalid');
  }
  return Object.freeze({
    token: parsed.token,
    generation: parsed.generation as number,
    expiresAtMs: parsed.expiresAtMs as number,
  });
}

function fenceNow(nowMs: () => number): number {
  const now = nowMs();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-clock-invalid');
  }
  return now;
}

/** Descriptor-bound generation fence; every WAL publication rechecks its non-expired token. */
export class HostedTaskBoardMutationFence {
  private constructor(
    private readonly teamDirectory: HostedTaskBoardDirectoryDescriptor,
    private readonly token: string,
    readonly generation: number,
    private readonly nowMs: () => number,
    private readonly durationMs: number
  ) {}

  static async acquire(input: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly nowMs: () => number;
    readonly durationMs: number;
    readonly assertStillActive?: () => void;
  }): Promise<HostedTaskBoardMutationFence | null> {
    if (
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1 ||
      input.durationMs > 60_000
    ) {
      throw new TypeError('hosted-task-board-mutation-fence-duration-invalid');
    }
    const token = randomUUID();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      input.assertStillActive?.();
      const now = fenceNow(input.nowMs);
      const snapshot = await readHostedTaskBoardFile(
        input.teamDirectory,
        HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
        MAX_FENCE_BYTES,
        { optional: true, assertStillActive: input.assertStillActive }
      );
      const current = snapshot.exists ? parseFence(snapshot.text) : null;
      if (current !== null && current.expiresAtMs > now) return null;
      const next = Object.freeze({
        token,
        generation: (current?.generation ?? 0) + 1,
        expiresAtMs: now + input.durationMs,
      });
      if (!Number.isSafeInteger(next.generation)) {
        throw new HostedTaskBoardDescriptorFsError(
          'hosted-task-board-mutation-fence-generation-invalid'
        );
      }
      try {
        if (snapshot.exists) {
          const replaced = await atomicReplaceFileIfUnchangedAsync(
            descriptorChildPath(input.teamDirectory, HOSTED_TASK_BOARD_MUTATION_FENCE_FILE),
            fencePayload(next),
            { identity: snapshot.stamp.durableIdentity, content: snapshot.text },
            { mode: 0o600 }
          );
          if (replaced === null) continue;
        } else {
          await atomicCreateAsync(
            descriptorChildPath(input.teamDirectory, HOSTED_TASK_BOARD_MUTATION_FENCE_FILE),
            fencePayload(next),
            { mode: 0o600, requireTrustworthyIdentity: true }
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const verified = await readHostedTaskBoardFile(
        input.teamDirectory,
        HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
        MAX_FENCE_BYTES,
        { assertStillActive: input.assertStillActive }
      );
      if (verified.exists) {
        const record = parseFence(verified.text);
        if (record.token === token && record.generation === next.generation) {
          return new HostedTaskBoardMutationFence(
            input.teamDirectory,
            token,
            next.generation,
            input.nowMs,
            input.durationMs
          );
        }
      }
    }
    return null;
  }

  async assertCurrent(assertStillActive?: () => void): Promise<void> {
    assertStillActive?.();
    const snapshot = await readHostedTaskBoardFile(
      this.teamDirectory,
      HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
      MAX_FENCE_BYTES,
      { assertStillActive }
    );
    const now = fenceNow(this.nowMs);
    if (!snapshot.exists)
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-lost');
    const current = parseFence(snapshot.text);
    if (
      current.token !== this.token ||
      current.generation !== this.generation ||
      current.expiresAtMs <= now
    ) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-lost');
    }
  }

  async renew(assertStillActive?: () => void): Promise<void> {
    await this.assertCurrent(assertStillActive);
    const snapshot = await readHostedTaskBoardFile(
      this.teamDirectory,
      HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
      MAX_FENCE_BYTES,
      { assertStillActive }
    );
    if (!snapshot.exists)
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-lost');
    const current = parseFence(snapshot.text);
    const now = fenceNow(this.nowMs);
    if (
      current.token !== this.token ||
      current.generation !== this.generation ||
      current.expiresAtMs <= now
    ) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-lost');
    }
    const replaced = await atomicReplaceFileIfUnchangedAsync(
      descriptorChildPath(this.teamDirectory, HOSTED_TASK_BOARD_MUTATION_FENCE_FILE),
      fencePayload(Object.freeze({ ...current, expiresAtMs: now + this.durationMs })),
      { identity: snapshot.stamp.durableIdentity, content: snapshot.text },
      { mode: 0o600 }
    );
    if (replaced === null)
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-mutation-fence-lost');
    await this.assertCurrent(assertStillActive);
  }

  async release(): Promise<void> {
    try {
      const snapshot = await readHostedTaskBoardFile(
        this.teamDirectory,
        HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
        MAX_FENCE_BYTES,
        { optional: true }
      );
      if (!snapshot.exists) return;
      const current = parseFence(snapshot.text);
      if (current.token !== this.token || current.generation !== this.generation) return;
      await atomicReplaceFileIfUnchangedAsync(
        descriptorChildPath(this.teamDirectory, HOSTED_TASK_BOARD_MUTATION_FENCE_FILE),
        fencePayload(Object.freeze({ ...current, expiresAtMs: fenceNow(this.nowMs) })),
        { identity: snapshot.stamp.durableIdentity, content: snapshot.text },
        { mode: 0o600 }
      );
    } catch {
      // Expiry remains the recovery path if the best-effort voluntary release races or fails.
    }
  }
}
