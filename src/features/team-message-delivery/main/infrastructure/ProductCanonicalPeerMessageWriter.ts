import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { InboxMessage, TaskRef } from '@shared/types';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REF = /^message_[a-f0-9]{64}$/;
const MAX_INBOX_BYTES = 10 * 1024 * 1024;
const MAX_INTENT_BYTES = 128 * 1024;
const MAX_MESSAGES = 20_000;

/** Structural Product port; the task-board boundary's private types stay private. */
type ProductPeerMember = Readonly<{
  workspaceId: string;
  teamId: string;
  workspaceRoot: string;
  planGeneration: string;
  runId: string;
  laneId: string;
  memberId: string;
  memberName: string;
  sessionID: string;
  actorId: string;
  deploymentId: string;
  bootId: string;
  restoreGeneration: number;
  mountGeneration: number;
  declaredRootHash: string;
  ownerAuthority: string;
  ownerGeneration: number;
  ownerSessionId: string;
}>;
type ProductPeerRecipientPin = Readonly<{
  teamId: string;
  runId: string;
  laneId: string;
  memberId: string;
  memberName: string;
  attemptId: string;
  containerHandle: string;
  containerGeneration: string;
  sessionId: string;
  planGeneration: string;
}>;
type ProductPeerTaskSnapshot = Readonly<{
  teamId: string;
  taskId: string;
  sourceGeneration: string;
  revision: string;
  ownerId: string | null;
  status: 'pending' | 'in_progress' | 'completed';
}>;
type PeerEffect = Readonly<{
  kind: 'message';
  member: ProductPeerMember;
  recipient: ProductPeerRecipientPin;
  taskRefs: readonly ProductPeerTaskSnapshot[];
  text: string;
}>;
type ProductPeerCanonicalEffect = PeerEffect | Readonly<{ kind: 'status' | 'comment' }>;

export type ProductPeerDeliveryIntent = Readonly<{
  schemaVersion: 1;
  kind: 'peer';
  effectId: string;
  fingerprint: string;
  receipt: string;
  authenticationTag: string;
  sourceRef: string;
  revision: string;
  runId: string;
  laneId: string;
  memberId: string;
  attemptId: string;
  containerHandle: string;
  containerGeneration: string;
  sessionId: string;
  planGeneration: string;
  inboxMemberName: string;
  sender: ProductPeerMember;
  message: InboxMessage;
}>;

export type ProductPeerOwnerDeliveryVersion = Readonly<{
  kind: 'peer';
  sourceRef: string;
  revision: string;
  runId: string;
  memberId: string;
  attemptId: string;
  containerHandle: string;
  containerGeneration: string;
}>;

type DirectoryIdentity = Readonly<{ path: string; dev: number; ino: number }>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function canonicalTaskId(teamId: string, rawTaskId: string): string {
  return `task_${hash({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }).slice(0, 32)}`;
}

function memberFields(member: ProductPeerMember): readonly unknown[] {
  return [
    member.workspaceId,
    member.teamId,
    member.workspaceRoot,
    member.planGeneration,
    member.runId,
    member.laneId,
    member.memberId,
    member.memberName,
    member.sessionID,
    member.actorId,
    member.deploymentId,
    member.bootId,
    member.restoreGeneration,
    member.mountGeneration,
    member.declaredRootHash,
    member.ownerAuthority,
    member.ownerGeneration,
    member.ownerSessionId,
  ];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..';
}

function readRegular(file: string, maximum: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || (stat.mode & 0o022) !== 0) {
    throw new Error('product-peer-file-unsafe');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maximum) {
      throw new Error('product-peer-file-substituted');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomic(file: string, serialized: string, maximum: number): void {
  if (Buffer.byteLength(serialized, 'utf8') > maximum) {
    throw new Error('product-peer-file-too-large');
  }
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.product-peer-${randomUUID()}.tmp`);
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function identity(directory: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
    throw new Error('product-peer-directory-unsafe');
  }
  return { path: fs.realpathSync.native(directory), dev: stat.dev, ino: stat.ino };
}

function sameDirectory(directory: string, expected: DirectoryIdentity): boolean {
  const stat = fs.lstatSync(directory);
  return (
    stat.isDirectory() &&
    (stat.mode & 0o022) === 0 &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    fs.realpathSync.native(directory) === expected.path
  );
}

/**
 * Product-owned, inactive canonical peer writer. The Product worker must call it
 * under its v35 decision's writer lock and SQLite BEGIN IMMEDIATE. Its immutable
 * intent is written before the inbox row, so replay repairs an interrupted inbox
 * append without making a second intent or dispatching a runtime action.
 */
export class ProductCanonicalPeerMessageWriter {
  private active = false;
  private readonly authenticationKey: Buffer;
  private readonly teamDirectory: string;
  private readonly inboxDirectory: string;
  private readonly outboxDirectory: string;
  private readonly anchors: readonly DirectoryIdentity[];

  constructor(
    private readonly trusted: Readonly<{
      teamId: string;
      teamName: string;
      teamDirectory: string;
      withProductWriterLock<T>(run: () => T): T;
      taskRefForCanonicalTask(task: ProductPeerTaskSnapshot): TaskRef | null;
      currentRecipient(runId: string, memberId: string): ProductPeerRecipientPin | null;
      currentSender(runId: string, memberId: string): ProductPeerMember | null;
      hasCommittedReceipt(effectId: string, fingerprint: string, receipt: string): boolean;
      /** Stable Product-owned secret, unavailable to agent containers; at least 256 bits. */
      authenticationKey: Buffer;
    }>
  ) {
    if (
      !path.isAbsolute(trusted.teamDirectory) ||
      !safeName(trusted.teamId) ||
      !safeName(trusted.teamName) ||
      !Buffer.isBuffer(trusted.authenticationKey) ||
      trusted.authenticationKey.length < 32
    ) {
      throw new Error('product-peer-config-invalid');
    }
    this.teamDirectory = trusted.teamDirectory;
    this.authenticationKey = Buffer.from(trusted.authenticationKey);
    this.inboxDirectory = path.join(this.teamDirectory, 'inboxes');
    this.outboxDirectory = path.join(this.teamDirectory, 'product-peer-outbox');
    this.anchors = [
      identity(this.teamDirectory),
      identity(this.inboxDirectory),
      identity(this.outboxDirectory),
    ];
    this.assertDirectories();
  }

  withExclusiveLock<T>(run: () => T): T {
    if (this.active) throw new Error('product-peer-writer-reentrant');
    return this.trusted.withProductWriterLock(() => {
      this.assertDirectories();
      this.active = true;
      try {
        return run();
      } finally {
        this.active = false;
      }
    });
  }

  findExactReceipt(effectId: string, fingerprint: string): string | null {
    this.assertLocked();
    this.assertIds(effectId, fingerprint);
    const intent = this.readIntent(`message_${effectId}`);
    if (!intent) return null;
    if (intent.fingerprint !== fingerprint) throw new Error('product-peer-idempotency-conflict');
    this.ensureInboxMessage(intent);
    return intent.receipt;
  }

  writeOnce(effectId: string, fingerprint: string, effect: ProductPeerCanonicalEffect): string {
    this.assertLocked();
    this.assertIds(effectId, fingerprint);
    const recovered = this.findExactReceipt(effectId, fingerprint);
    if (recovered !== null) return recovered;
    if (effect.kind !== 'message') throw new Error('product-peer-effect-kind-unsupported');
    const intent = this.createIntent(effectId, fingerprint, effect);
    // This file is the WAL. A crash from here through SQLite receipt commit is
    // recovered by findExactReceipt while holding the same Product writer lock.
    writeAtomic(
      this.intentPath(intent.sourceRef),
      `${JSON.stringify(intent, null, 2)}\n`,
      MAX_INTENT_BYTES
    );
    this.ensureInboxMessage(intent);
    return intent.receipt;
  }

  /** Exact immutable version for Owner/root source resolution; never dispatches. */
  readCommitted(sourceRef: string): ProductPeerDeliveryIntent | null {
    return this.withExclusiveLock(() => {
      const intent = this.readIntent(sourceRef);
      if (!intent) return null;
      if (!this.trusted.hasCommittedReceipt(intent.effectId, intent.fingerprint, intent.receipt)) {
        return null;
      }
      if (!this.senderMatches(intent) || !this.recipientMatches(intent)) return null;
      this.ensureInboxMessage(intent);
      return intent;
    });
  }

  /** Exact Owner bridge projection. Text and task refs stay on Product. */
  resolveOwnerDelivery(sourceRef: string): ProductPeerOwnerDeliveryVersion | null {
    const intent = this.readCommitted(sourceRef);
    if (!intent) return null;
    return {
      kind: 'peer',
      sourceRef: intent.sourceRef,
      revision: intent.revision,
      runId: intent.runId,
      memberId: intent.memberId,
      attemptId: intent.attemptId,
      containerHandle: intent.containerHandle,
      containerGeneration: intent.containerGeneration,
    };
  }

  private createIntent(
    effectId: string,
    fingerprint: string,
    effect: PeerEffect
  ): ProductPeerDeliveryIntent {
    const { member, recipient } = effect;
    if (
      member.teamId !== this.trusted.teamId ||
      recipient.teamId !== this.trusted.teamId ||
      !safeName(recipient.memberName) ||
      !recipient.attemptId ||
      !recipient.containerHandle ||
      !recipient.containerGeneration ||
      !recipient.sessionId ||
      recipient.planGeneration !== member.planGeneration ||
      recipient.runId !== member.runId ||
      recipient.memberId === member.memberId
    ) {
      throw new Error('product-peer-target-invalid');
    }
    if (
      !effect.text.trim() ||
      Buffer.byteLength(effect.text, 'utf8') > 64 * 1024 ||
      effect.taskRefs.length > 512
    )
      throw new Error('product-peer-message-invalid');
    const taskRefs = effect.taskRefs.map((task) => {
      if (task.teamId !== this.trusted.teamId) throw new Error('product-peer-task-ref-foreign');
      const mapped = this.trusted.taskRefForCanonicalTask(task);
      if (
        !mapped ||
        !safeName(mapped.taskId) ||
        canonicalTaskId(this.trusted.teamId, mapped.taskId) !== task.taskId ||
        mapped.teamName !== this.trusted.teamName ||
        !mapped.displayId
      )
        throw new Error('product-peer-task-ref-unresolved');
      return mapped;
    });
    const sourceRef = `message_${effectId}`;
    const message: InboxMessage = {
      from: member.memberName,
      to: recipient.memberName,
      text: effect.text,
      timestamp: new Date().toISOString(),
      read: false,
      messageId: sourceRef,
      ...(taskRefs.length ? { taskRefs } : {}),
    };
    const basis = {
      kind: 'peer' as const,
      sourceRef,
      runId: recipient.runId,
      laneId: recipient.laneId,
      memberId: recipient.memberId,
      attemptId: recipient.attemptId,
      containerHandle: recipient.containerHandle,
      containerGeneration: recipient.containerGeneration,
      sessionId: recipient.sessionId,
      planGeneration: recipient.planGeneration,
      inboxMemberName: recipient.memberName,
      sender: member,
      message,
    };
    const unsigned = {
      schemaVersion: 1 as const,
      effectId,
      fingerprint,
      receipt: `hosted-product-peer:${sourceRef}`,
      ...basis,
      revision: hash(['hosted-product-peer-intent/v1', basis]),
    };
    return { ...unsigned, authenticationTag: this.authenticate(unsigned) };
  }

  private authenticate(value: unknown): string {
    return createHmac('sha256', this.authenticationKey)
      .update(JSON.stringify(['hosted-product-peer-intent-auth/v1', value]), 'utf8')
      .digest('hex');
  }

  private recipientMatches(intent: ProductPeerDeliveryIntent): boolean {
    const current = this.trusted.currentRecipient(intent.runId, intent.memberId);
    return Boolean(
      current &&
      current.teamId === this.trusted.teamId &&
      current.runId === intent.runId &&
      current.laneId === intent.laneId &&
      current.memberId === intent.memberId &&
      current.memberName === intent.inboxMemberName &&
      current.attemptId === intent.attemptId &&
      current.containerHandle === intent.containerHandle &&
      current.containerGeneration === intent.containerGeneration &&
      current.sessionId === intent.sessionId &&
      current.planGeneration === intent.planGeneration
    );
  }

  private senderMatches(intent: ProductPeerDeliveryIntent): boolean {
    const current = this.trusted.currentSender(intent.sender.runId, intent.sender.memberId);
    return current !== null && hash(memberFields(current)) === hash(memberFields(intent.sender));
  }

  private ensureInboxMessage(intent: ProductPeerDeliveryIntent): void {
    const file = path.join(this.inboxDirectory, `${intent.inboxMemberName}.json`);
    const serialized = readRegular(file, MAX_INBOX_BYTES);
    const parsed: unknown = serialized === null ? [] : JSON.parse(serialized);
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_MESSAGES ||
      !parsed.every(
        (item) =>
          record(item) &&
          typeof item.from === 'string' &&
          typeof item.text === 'string' &&
          typeof item.timestamp === 'string' &&
          typeof item.read === 'boolean'
      )
    ) {
      throw new Error('product-peer-inbox-invalid');
    }
    const matches = parsed.filter((item) => item.messageId === intent.sourceRef);
    if (matches.length > 1) throw new Error('product-peer-inbox-duplicate');
    if (matches.length === 1) {
      const { read: _read, ...existing } = matches[0];
      const { read: _initialRead, ...expected } = intent.message;
      if (hash(existing) !== hash(expected)) throw new Error('product-peer-inbox-conflict');
      return;
    }
    if (parsed.length === MAX_MESSAGES) throw new Error('product-peer-inbox-full');
    if (!this.senderMatches(intent)) throw new Error('product-peer-sender-rotated');
    if (!this.recipientMatches(intent)) throw new Error('product-peer-recipient-rotated');
    writeAtomic(file, JSON.stringify([...parsed, intent.message], null, 2), MAX_INBOX_BYTES);
  }

  private readIntent(sourceRef: string): ProductPeerDeliveryIntent | null {
    if (!SOURCE_REF.test(sourceRef)) throw new Error('product-peer-source-ref-invalid');
    const serialized = readRegular(this.intentPath(sourceRef), MAX_INTENT_BYTES);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (
      !record(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.kind !== 'peer' ||
      parsed.sourceRef !== sourceRef ||
      parsed.effectId !== sourceRef.slice('message_'.length) ||
      typeof parsed.fingerprint !== 'string' ||
      !SHA256.test(parsed.fingerprint) ||
      typeof parsed.authenticationTag !== 'string' ||
      !SHA256.test(parsed.authenticationTag) ||
      parsed.receipt !== `hosted-product-peer:${sourceRef}` ||
      typeof parsed.revision !== 'string' ||
      !SHA256.test(parsed.revision) ||
      typeof parsed.inboxMemberName !== 'string' ||
      !safeName(parsed.inboxMemberName) ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.laneId !== 'string' ||
      typeof parsed.memberId !== 'string' ||
      typeof parsed.attemptId !== 'string' ||
      typeof parsed.containerHandle !== 'string' ||
      typeof parsed.containerGeneration !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.planGeneration !== 'string' ||
      !record(parsed.message) ||
      !record(parsed.sender) ||
      parsed.sender.runId !== parsed.runId ||
      parsed.sender.teamId !== this.trusted.teamId ||
      typeof parsed.sender.memberId !== 'string' ||
      typeof parsed.sender.sessionID !== 'string' ||
      parsed.message.messageId !== sourceRef ||
      parsed.message.to !== parsed.inboxMemberName ||
      typeof parsed.message.from !== 'string' ||
      !parsed.message.from ||
      typeof parsed.message.text !== 'string' ||
      !parsed.message.text.trim() ||
      typeof parsed.message.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(parsed.message.timestamp)) ||
      parsed.message.read !== false ||
      (parsed.message.taskRefs !== undefined &&
        (!Array.isArray(parsed.message.taskRefs) || parsed.message.taskRefs.length > 512))
    ) {
      throw new Error('product-peer-intent-invalid');
    }
    const {
      schemaVersion: _schemaVersion,
      effectId: _effectId,
      fingerprint: _fingerprint,
      receipt: _receipt,
      revision: _revision,
      authenticationTag: _authenticationTag,
      ...basis
    } = parsed;
    if (hash(['hosted-product-peer-intent/v1', basis]) !== parsed.revision) {
      throw new Error('product-peer-intent-revision-invalid');
    }
    const { authenticationTag, ...unsigned } = parsed;
    const expectedTag = this.authenticate(unsigned);
    if (!timingSafeEqual(Buffer.from(authenticationTag, 'hex'), Buffer.from(expectedTag, 'hex'))) {
      throw new Error('product-peer-intent-authentication-invalid');
    }
    return parsed as ProductPeerDeliveryIntent;
  }

  private intentPath(sourceRef: string): string {
    return path.join(this.outboxDirectory, `${sourceRef}.json`);
  }

  private assertDirectories(): void {
    const directories = [this.teamDirectory, this.inboxDirectory, this.outboxDirectory];
    if (
      directories.some((directory, index) => !sameDirectory(directory, this.anchors[index])) ||
      !this.anchors[1].path.startsWith(`${this.anchors[0].path}${path.sep}`) ||
      !this.anchors[2].path.startsWith(`${this.anchors[0].path}${path.sep}`)
    ) {
      throw new Error('product-peer-directory-substituted');
    }
  }

  private assertLocked(): void {
    if (!this.active) throw new Error('product-peer-writer-lock-required');
    this.assertDirectories();
  }

  private assertIds(effectId: string, fingerprint: string): void {
    if (!SHA256.test(effectId) || !SHA256.test(fingerprint)) {
      throw new Error('product-peer-effect-id-invalid');
    }
  }
}
