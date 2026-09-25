import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ProductCanonicalEffect,
  ProductCanonicalEffectWriter,
} from './HostedProductTaskEffectBoundary';

type JsonRecord = Record<string, unknown>;
type EffectMarker = Readonly<{ fingerprint: string; receipt: string; kind: 'status' | 'comment' }>;

const MAX_TASKS = 512;
const MAX_TASK_BYTES = 256 * 1024;
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MARKERS = '_hostedProductEffects';

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalTaskId(teamId: string, rawTaskId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }), 'utf8')
    .digest('hex');
  return `task_${digest.slice(0, 32)}`;
}

function readTask(filePath: string, rawTaskId: string): JsonRecord {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TASK_BYTES) {
    throw new Error('product-canonical-task-file-unsafe');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_TASK_BYTES) {
      throw new Error('product-canonical-task-file-changed');
    }
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    String(value.id) !== rawTaskId ||
    !['pending', 'in_progress', 'completed'].includes(String(value.status))
  ) {
    throw new Error('product-canonical-task-file-invalid');
  }
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
    (value.kind === 'status' || value.kind === 'comment')
  );
}

function syncReplace(filePath: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_TASK_BYTES) {
    throw new Error('product-canonical-task-file-too-large');
  }
  const parent = path.dirname(filePath);
  const temp = path.join(parent, `.hosted-product-effect-${randomUUID()}.tmp`);
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
  try {
    fs.renameSync(temp, filePath);
    const directoryFd = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
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
 */
export class ProductCanonicalTaskFileWriter implements ProductCanonicalEffectWriter {
  private active = false;
  private readonly directoryIdentity: Readonly<{ path: string; device: number; inode: number }>;

  constructor(
    private readonly trusted: Readonly<{
      teamId: string;
      tasksDirectory: string;
      rawTaskIdForCanonicalTaskId(taskId: string): string | null;
      withProductWriterLock<T>(run: () => T): T;
    }>
  ) {
    if (!path.isAbsolute(trusted.tasksDirectory) || !trusted.teamId) {
      throw new Error('product-canonical-writer-config-invalid');
    }
    const stat = fs.lstatSync(trusted.tasksDirectory);
    if (!stat.isDirectory()) throw new Error('product-canonical-task-directory-unsafe');
    this.directoryIdentity = {
      path: fs.realpathSync.native(trusted.tasksDirectory),
      device: stat.dev,
      inode: stat.ino,
    };
    this.assertDirectory();
  }

  withExclusiveLock<T>(run: () => T): T {
    if (this.active) throw new Error('product-canonical-writer-reentrant');
    return this.trusted.withProductWriterLock(() => {
      this.assertDirectory();
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
    let receipt: string | null = null;
    const names = fs.readdirSync(this.trusted.tasksDirectory);
    if (names.length > MAX_TASKS) throw new Error('product-canonical-task-directory-too-large');
    for (const name of names) {
      const match = TASK_FILE.exec(name);
      if (!match) continue;
      const task = readTask(path.join(this.trusted.tasksDirectory, name), match[1]);
      const found = markers(task)[effectId];
      if (found === undefined) continue;
      if (!exactMarker(found)) throw new Error('product-canonical-effect-marker-invalid');
      if (found.fingerprint !== fingerprint)
        throw new Error('product-canonical-idempotency-conflict');
      if (receipt !== null) throw new Error('product-canonical-effect-duplicate');
      receipt = found.receipt;
    }
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
    const task = readTask(filePath, rawTaskId);
    if (task.owner !== effect.member.memberName && task.owner !== effect.member.memberId) {
      throw new Error('product-canonical-task-owner-changed');
    }
    const now = new Date().toISOString();
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
      task.historyEvents = [
        ...(Array.isArray(task.historyEvents) ? task.historyEvents : []),
        {
          id: effectId,
          timestamp: now,
          type: 'status_changed',
          from: expected,
          to: effect.status,
          actor: effect.member.memberName,
        },
      ];
      task.status = effect.status;
    } else {
      if (task.status !== effect.task.status || !Array.isArray(task.comments ?? [])) {
        throw new Error('product-canonical-task-changed');
      }
      task.comments = [
        ...((task.comments ?? []) as unknown[]),
        {
          id: effectId,
          author: effect.member.memberName,
          text: effect.text,
          createdAt: now,
          type: 'regular',
        },
      ];
    }
    const receipt = `hosted-product-effect:${effectId}`;
    task[MARKERS] = { ...markers(task), [effectId]: { fingerprint, receipt, kind: effect.kind } };
    syncReplace(filePath, JSON.stringify(task, null, 2));
    return receipt;
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

  private assertLocked(): void {
    if (!this.active) throw new Error('product-canonical-writer-lock-required');
    this.assertDirectory();
  }

  private assertIds(effectId: string, fingerprint: string): void {
    if (!SHA256.test(effectId) || !SHA256.test(fingerprint)) {
      throw new Error('product-canonical-effect-id-invalid');
    }
  }
}
