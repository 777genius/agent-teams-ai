import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ProductCanonicalEffect,
  ProductCanonicalEffectWriter,
} from './HostedProductTaskEffectBoundary';

type JsonRecord = Record<string, unknown>;
type EffectKind = 'status' | 'comment';
type EffectIntent = Readonly<{
  schemaVersion: 2;
  effectId: string;
  fingerprint: string;
  receipt: string;
  kind: EffectKind;
  teamId: string;
  rawTaskId: string;
  sourceGeneration: string;
  revision: string;
  evidenceDigest: string;
  preimageDigest: string;
  intentSignature: string;
}>;
type EffectMarker = Readonly<{
  fingerprint: string;
  receipt: string;
  kind: EffectKind;
  sourceGeneration: string;
  revision: string;
  evidenceDigest: string;
  signature: string;
}>;

const MAX_TASKS = 512;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MARKERS = '_hostedProductEffects';
const MAX_INTENT_BYTES = 4096;

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalTaskId(teamId: string, rawTaskId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }), 'utf8')
    .digest('hex');
  return `task_${digest.slice(0, 32)}`;
}

function readTask(
  filePath: string,
  rawTaskId: string,
  budget?: { remainingBytes: number },
  observed?: { digest: string }
): JsonRecord {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TASK_BYTES) {
    throw new Error('product-canonical-task-file-unsafe');
  }
  if (budget && stat.size > budget.remainingBytes) {
    throw new Error('product-canonical-task-snapshot-too-large');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  let byteLength = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_TASK_BYTES) {
      throw new Error('product-canonical-task-file-changed');
    }
    const buffer = Buffer.allocUnsafe(
      Math.min(MAX_TASK_BYTES, budget?.remainingBytes ?? MAX_TASK_BYTES) + 1
    );
    while (byteLength < buffer.byteLength) {
      const read = fs.readSync(fd, buffer, byteLength, buffer.byteLength - byteLength, null);
      if (read === 0) break;
      byteLength += read;
    }
    if (byteLength > MAX_TASK_BYTES) throw new Error('product-canonical-task-file-unsafe');
    if (budget && byteLength > budget.remainingBytes) {
      throw new Error('product-canonical-task-snapshot-too-large');
    }
    text = buffer.toString('utf8', 0, byteLength);
    if (observed)
      observed.digest = createHash('sha256').update(buffer.subarray(0, byteLength)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    String(value.id) !== rawTaskId ||
    !['pending', 'in_progress', 'completed', 'deleted'].includes(String(value.status))
  ) {
    throw new Error('product-canonical-task-file-invalid');
  }
  if (budget) budget.remainingBytes -= byteLength;
  return value;
}

function markers(task: JsonRecord): JsonRecord {
  const value = task[MARKERS];
  if (value === undefined) return {};
  if (!record(value)) throw new Error('product-canonical-effect-markers-invalid');
  return value;
}

function exactMarker(value: unknown): value is EffectMarker {
  return (
    record(value) &&
    typeof value.fingerprint === 'string' &&
    SHA256.test(value.fingerprint) &&
    typeof value.receipt === 'string' &&
    value.receipt.length > 0 &&
    (value.kind === 'status' || value.kind === 'comment') &&
    typeof value.sourceGeneration === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.evidenceDigest === 'string' &&
    SHA256.test(value.evidenceDigest) &&
    typeof value.signature === 'string' &&
    SHA256.test(value.signature)
  );
}

function evidenceDigest(kind: EffectKind, evidence: JsonRecord): string {
  const fields =
    kind === 'status'
      ? [
          'status',
          evidence.id,
          evidence.timestamp,
          evidence.type,
          evidence.from,
          evidence.to,
          evidence.actor,
        ]
      : ['comment', evidence.id, evidence.author, evidence.text, evidence.createdAt, evidence.type];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function matchingEvidence(task: JsonRecord, intent: EffectIntent): boolean {
  const entries = intent.kind === 'status' ? task.historyEvents : task.comments;
  if (!Array.isArray(entries)) return false;
  const matches = entries.filter((value) => record(value) && value.id === intent.effectId);
  return (
    matches.length === 1 &&
    evidenceDigest(intent.kind, matches[0] as JsonRecord) === intent.evidenceDigest
  );
}

function trustedMarker(
  task: JsonRecord,
  intent: EffectIntent,
  fingerprint: string,
  validSignature: (value: string) => boolean
): boolean {
  const found = markers(task)[intent.effectId];
  return (
    exactMarker(found) &&
    found.fingerprint === fingerprint &&
    found.receipt === intent.receipt &&
    found.kind === intent.kind &&
    found.sourceGeneration === intent.sourceGeneration &&
    found.revision === intent.revision &&
    found.evidenceDigest === intent.evidenceDigest &&
    validSignature(found.signature) &&
    matchingEvidence(task, intent)
  );
}

function exactIntent(value: unknown): value is EffectIntent {
  return (
    record(value) &&
    value.schemaVersion === 2 &&
    typeof value.effectId === 'string' &&
    SHA256.test(value.effectId) &&
    typeof value.fingerprint === 'string' &&
    SHA256.test(value.fingerprint) &&
    typeof value.receipt === 'string' &&
    value.receipt.length > 0 &&
    (value.kind === 'status' || value.kind === 'comment') &&
    typeof value.teamId === 'string' &&
    typeof value.rawTaskId === 'string' &&
    typeof value.sourceGeneration === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.evidenceDigest === 'string' &&
    SHA256.test(value.evidenceDigest) &&
    typeof value.preimageDigest === 'string' &&
    SHA256.test(value.preimageDigest) &&
    typeof value.intentSignature === 'string' &&
    SHA256.test(value.intentSignature)
  );
}

class TaskReplaceFailure extends Error {
  constructor(
    error: unknown,
    readonly published: boolean
  ) {
    super(error instanceof Error ? error.message : String(error));
  }
}

function syncReplace(filePath: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_TASK_BYTES) {
    throw new Error('product-canonical-task-file-too-large');
  }
  const parent = path.dirname(filePath);
  const temp = path.join(parent, `.hosted-product-effect-${randomUUID()}.tmp`);
  let published = false;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    const fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode
    );
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, filePath);
    published = true;
    const directoryFd = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    throw new TaskReplaceFailure(error, published);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/**
 * Inert Product-side file adapter. Its paths and raw task-id lookup come only from the
 * Product mount/board authority. The supplied lock must be the same writer lock held
 * across the v35 decision, file write, and SQLite receipt transaction.
 *
 * Peer messages fail closed until Product has a durable inbox-plus-wake protocol.
 * Task JSON may be writable by an agent. Recovery therefore requires both a
 * Product-protected intent and a keyed marker over the exact effect evidence.
 * A missing or changed marker with a prepared intent is ambiguous and never
 * causes a second task write.
 */
export class ProductCanonicalTaskFileWriter implements ProductCanonicalEffectWriter {
  private active = false;
  private readonly directoryIdentity: Readonly<{ path: string; device: number; inode: number }>;
  private readonly journalIdentity: Readonly<{ path: string; device: number; inode: number }>;
  private readonly receiptKey: Buffer;

  constructor(
    private readonly trusted: Readonly<{
      teamId: string;
      tasksDirectory: string;
      protectedJournalDirectory: string;
      receiptKey: Buffer;
      rawTaskIdForCanonicalTaskId(taskId: string): string | null;
      withProductWriterLock<T>(run: () => T): T;
    }>
  ) {
    if (
      !path.isAbsolute(trusted.tasksDirectory) ||
      !path.isAbsolute(trusted.protectedJournalDirectory) ||
      !trusted.teamId ||
      !Buffer.isBuffer(trusted.receiptKey) ||
      trusted.receiptKey.length < 32
    ) {
      throw new Error('product-canonical-writer-config-invalid');
    }
    this.receiptKey = Buffer.from(trusted.receiptKey);
    const stat = fs.lstatSync(trusted.tasksDirectory);
    if (!stat.isDirectory()) throw new Error('product-canonical-task-directory-unsafe');
    this.directoryIdentity = {
      path: fs.realpathSync.native(trusted.tasksDirectory),
      device: stat.dev,
      inode: stat.ino,
    };
    const journalStat = fs.lstatSync(trusted.protectedJournalDirectory);
    if (
      !journalStat.isDirectory() ||
      journalStat.isSymbolicLink() ||
      (journalStat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && journalStat.uid !== process.getuid())
    ) {
      throw new Error('product-canonical-journal-directory-unsafe');
    }
    this.journalIdentity = {
      path: fs.realpathSync.native(trusted.protectedJournalDirectory),
      device: journalStat.dev,
      inode: journalStat.ino,
    };
    const relativeToTasks = path.relative(this.directoryIdentity.path, this.journalIdentity.path);
    if (
      relativeToTasks === '' ||
      (!relativeToTasks.startsWith(`..${path.sep}`) &&
        relativeToTasks !== '..' &&
        !path.isAbsolute(relativeToTasks))
    ) {
      throw new Error('product-canonical-journal-directory-unsafe');
    }
    this.assertDirectory();
    this.assertJournalDirectory();
  }

  withExclusiveLock<T>(run: () => T): T {
    if (this.active) throw new Error('product-canonical-writer-reentrant');
    return this.trusted.withProductWriterLock(() => {
      this.assertDirectory();
      this.assertJournalDirectory();
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
    const intent = this.readIntent(effectId);
    if (intent && (intent.fingerprint !== fingerprint || intent.teamId !== this.trusted.teamId)) {
      throw new Error('product-canonical-idempotency-conflict');
    }
    let receipt: string | null = null;
    const budget = { remainingBytes: MAX_TASK_SNAPSHOT_BYTES };
    const directory = fs.opendirSync(this.trusted.tasksDirectory);
    try {
      let count = 0;
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        count += 1;
        if (count > MAX_TASKS) throw new Error('product-canonical-task-directory-too-large');
        const match = TASK_FILE.exec(entry.name);
        if (!match) continue;
        const task = readTask(path.join(this.trusted.tasksDirectory, entry.name), match[1], budget);
        const found = markers(task)[effectId];
        if (found === undefined) continue;
        if (exactMarker(found) && found.fingerprint !== fingerprint)
          throw new Error('product-canonical-idempotency-conflict');
        if (
          !intent ||
          match[1] !== intent.rawTaskId ||
          !trustedMarker(task, intent, fingerprint, (value) => this.validSignature(intent, value))
        ) {
          throw new Error('product-canonical-effect-untrusted');
        }
        if (receipt !== null) throw new Error('product-canonical-effect-duplicate');
        receipt = intent.receipt;
      }
    } finally {
      directory.closeSync();
    }
    // Agent-writable bytes may have been restored after publication. A missing
    // marker with a durable prepared intent therefore always needs operator
    // recovery, even when the current file matches the signed preimage.
    if (intent && receipt === null) throw new Error('product-canonical-effect-ambiguous');
    if (intent && receipt !== null) this.confirmRecoveredTaskDurability(intent, fingerprint);
    return receipt;
  }

  writeOnce(effectId: string, fingerprint: string, effect: ProductCanonicalEffect): string {
    this.assertLocked();
    this.assertIds(effectId, fingerprint);
    const recovered = this.findExactReceipt(effectId, fingerprint);
    if (recovered !== null) return recovered;
    if (effect.kind === 'message') throw new Error('product-canonical-message-wake-unavailable');
    if (
      effect.member.teamId !== this.trusted.teamId ||
      effect.task.teamId !== this.trusted.teamId
    ) {
      throw new Error('product-canonical-team-mismatch');
    }
    const rawTaskId = this.trusted.rawTaskIdForCanonicalTaskId(effect.task.taskId);
    if (
      !rawTaskId ||
      !TASK_FILE.test(`${rawTaskId}.json`) ||
      canonicalTaskId(this.trusted.teamId, rawTaskId) !== effect.task.taskId
    ) {
      throw new Error('product-canonical-task-id-unresolved');
    }
    const filePath = path.join(this.trusted.tasksDirectory, `${rawTaskId}.json`);
    const observed = { digest: '' };
    const task = readTask(filePath, rawTaskId, undefined, observed);
    if (
      [
        ...(Array.isArray(task.historyEvents) ? task.historyEvents : []),
        ...(Array.isArray(task.comments) ? task.comments : []),
      ].some((entry) => record(entry) && entry.id === effectId)
    ) {
      throw new Error('product-canonical-effect-untrusted');
    }
    if (task.owner !== effect.member.memberName && task.owner !== effect.member.memberId) {
      throw new Error('product-canonical-task-owner-changed');
    }
    const now = new Date().toISOString();
    let evidence: JsonRecord;
    if (effect.kind === 'status') {
      const expected = effect.status === 'in_progress' ? 'pending' : 'in_progress';
      if (task.status !== expected || effect.task.status !== expected) {
        throw new Error('product-canonical-task-status-changed');
      }
      const intervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
      if (effect.status === 'in_progress') intervals.push({ startedAt: now });
      else if (
        intervals.length > 0 &&
        record(intervals[intervals.length - 1]) &&
        intervals[intervals.length - 1].completedAt === undefined
      ) {
        intervals[intervals.length - 1] = { ...intervals[intervals.length - 1], completedAt: now };
      }
      task.workIntervals = intervals;
      evidence = {
        id: effectId,
        timestamp: now,
        type: 'status_changed',
        from: expected,
        to: effect.status,
        actor: effect.member.memberName,
      };
      task.historyEvents = [
        ...(Array.isArray(task.historyEvents) ? task.historyEvents : []),
        evidence,
      ];
      task.status = effect.status;
    } else {
      if (task.status !== effect.task.status || !Array.isArray(task.comments ?? [])) {
        throw new Error('product-canonical-task-changed');
      }
      evidence = {
        id: effectId,
        author: effect.member.memberName,
        text: effect.text,
        createdAt: now,
        type: 'regular',
      };
      task.comments = [...((task.comments ?? []) as unknown[]), evidence];
    }
    const receipt = `hosted-product-effect:${effectId}`;
    const unsignedIntent = {
      schemaVersion: 2 as const,
      effectId,
      fingerprint,
      receipt,
      kind: effect.kind,
      teamId: this.trusted.teamId,
      rawTaskId,
      sourceGeneration: effect.task.sourceGeneration,
      revision: effect.task.revision,
      evidenceDigest: evidenceDigest(effect.kind, evidence),
      preimageDigest: observed.digest,
    };
    const intent: EffectIntent = {
      ...unsignedIntent,
      intentSignature: this.signIntent(unsignedIntent),
    };
    task[MARKERS] = {
      ...markers(task),
      [effectId]: {
        fingerprint,
        receipt,
        kind: effect.kind,
        sourceGeneration: intent.sourceGeneration,
        revision: intent.revision,
        evidenceDigest: intent.evidenceDigest,
        signature: this.signature(intent),
      },
    };
    const postimage = JSON.stringify(task, null, 2);
    if (Buffer.byteLength(postimage, 'utf8') > MAX_TASK_BYTES)
      throw new Error('product-canonical-task-file-too-large');
    this.writeIntent(intent);
    try {
      syncReplace(filePath, postimage);
    } catch (error) {
      // Only this live call knows that rename did not complete. A crash loses
      // that evidence, so recovery never clears a prepared intent by file bytes.
      if (error instanceof TaskReplaceFailure && !error.published) this.removeIntent(effectId);
      throw error;
    }
    return receipt;
  }

  private confirmRecoveredTaskDurability(intent: EffectIntent, fingerprint: string): void {
    const filePath = path.join(this.trusted.tasksDirectory, `${intent.rawTaskId}.json`);
    const before = { digest: '' };
    const task = readTask(filePath, intent.rawTaskId, undefined, before);
    if (!trustedMarker(task, intent, fingerprint, (value) => this.validSignature(intent, value)))
      throw new Error('product-canonical-effect-untrusted');
    const stat = fs.lstatSync(filePath);
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        throw new Error('product-canonical-effect-task-changed');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directoryFd = fs.openSync(
      this.trusted.tasksDirectory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const directory = fs.fstatSync(directoryFd);
      if (
        directory.dev !== this.directoryIdentity.device ||
        directory.ino !== this.directoryIdentity.inode
      )
        throw new Error('product-canonical-task-directory-unsafe');
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    const afterStat = fs.lstatSync(filePath);
    const after = { digest: '' };
    const afterTask = readTask(filePath, intent.rawTaskId, undefined, after);
    if (
      afterStat.dev !== stat.dev ||
      afterStat.ino !== stat.ino ||
      before.digest !== after.digest ||
      !trustedMarker(afterTask, intent, fingerprint, (value) => this.validSignature(intent, value))
    )
      throw new Error('product-canonical-effect-task-changed');
  }

  private assertDirectory(): void {
    const stat = fs.lstatSync(this.trusted.tasksDirectory);
    if (
      !stat.isDirectory() ||
      stat.dev !== this.directoryIdentity.device ||
      stat.ino !== this.directoryIdentity.inode ||
      fs.realpathSync.native(this.trusted.tasksDirectory) !== this.directoryIdentity.path
    ) {
      throw new Error('product-canonical-task-directory-unsafe');
    }
  }

  private assertJournalDirectory(): void {
    const stat = fs.lstatSync(this.trusted.protectedJournalDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.journalIdentity.device ||
      stat.ino !== this.journalIdentity.inode ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      fs.realpathSync.native(this.trusted.protectedJournalDirectory) !== this.journalIdentity.path
    ) {
      throw new Error('product-canonical-journal-directory-unsafe');
    }
  }

  private intentPath(effectId: string): string {
    return path.join(this.trusted.protectedJournalDirectory, `${effectId}.json`);
  }

  private readIntent(effectId: string): EffectIntent | null {
    this.assertJournalDirectory();
    const filePath = this.intentPath(effectId);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > MAX_INTENT_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error('product-canonical-effect-intent-unsafe');
    }
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw: string;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        throw new Error('product-canonical-effect-intent-changed');
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('product-canonical-effect-intent-invalid');
    }
    if (
      !exactIntent(parsed) ||
      parsed.effectId !== effectId ||
      !this.validMac(this.signIntent(parsed), parsed.intentSignature)
    )
      throw new Error('product-canonical-effect-intent-invalid');
    return parsed;
  }

  private writeIntent(intent: EffectIntent): void {
    this.assertJournalDirectory();
    const serialized = `${JSON.stringify(intent)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INTENT_BYTES)
      throw new Error('product-canonical-effect-intent-too-large');
    const filePath = this.intentPath(intent.effectId);
    try {
      fs.lstatSync(filePath);
      throw new Error('product-canonical-effect-intent-exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = path.join(
      this.trusted.protectedJournalDirectory,
      `.hosted-product-intent-${randomUUID()}.tmp`
    );
    try {
      const fd = fs.openSync(
        temp,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        fs.writeFileSync(fd, serialized, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, filePath);
      try {
        this.syncJournalDirectory();
      } catch (error) {
        // Task publication has not started. Discard the unconfirmed intent
        // only when its removal can also be synced in this live call.
        try {
          fs.unlinkSync(filePath);
          this.syncJournalDirectory();
        } catch {
          throw new Error('product-canonical-effect-intent-publication-uncertain');
        }
        throw error;
      }
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  private removeIntent(effectId: string): void {
    this.assertJournalDirectory();
    fs.unlinkSync(this.intentPath(effectId));
    this.syncJournalDirectory();
  }

  private syncJournalDirectory(): void {
    const fd = fs.openSync(
      this.trusted.protectedJournalDirectory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private signIntent(intent: Omit<EffectIntent, 'intentSignature'>): string {
    return createHmac('sha256', this.receiptKey)
      .update(
        JSON.stringify([
          'hosted-product-task-effect-intent/v2',
          intent.effectId,
          intent.fingerprint,
          intent.receipt,
          intent.kind,
          intent.teamId,
          intent.rawTaskId,
          intent.sourceGeneration,
          intent.revision,
          intent.evidenceDigest,
          intent.preimageDigest,
        ])
      )
      .digest('hex');
  }

  private signature(intent: EffectIntent): string {
    return createHmac('sha256', this.receiptKey)
      .update(
        JSON.stringify([
          'hosted-product-task-effect-marker/v2',
          intent.effectId,
          intent.fingerprint,
          intent.receipt,
          intent.kind,
          intent.teamId,
          intent.rawTaskId,
          intent.sourceGeneration,
          intent.revision,
          intent.evidenceDigest,
          intent.preimageDigest,
        ])
      )
      .digest('hex');
  }

  private validSignature(intent: EffectIntent, value: string): boolean {
    return this.validMac(this.signature(intent), value);
  }

  private validMac(expectedHex: string, value: string): boolean {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(value, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private assertLocked(): void {
    if (!this.active) throw new Error('product-canonical-writer-lock-required');
    this.assertDirectory();
    this.assertJournalDirectory();
  }

  private assertIds(effectId: string, fingerprint: string): void {
    if (!SHA256.test(effectId) || !SHA256.test(fingerprint)) {
      throw new Error('product-canonical-effect-id-invalid');
    }
  }
}
