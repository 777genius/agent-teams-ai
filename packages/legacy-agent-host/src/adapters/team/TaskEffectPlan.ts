import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { TeamOwnerError } from '../../team/contracts.js';
import { digest, safeSegment } from '../../team/identity.js';
import { createTeamController } from './ControllerAdapter.js';
import { TaskPolicyRejected } from '../../team/ports.js';

import type { CommandReceipt } from '../../team/contracts.js';
import type { JsonValue } from '../../contracts.js';
import type {
  PreparedTaskMutation,
  TaskBoardPolicy,
  TaskMutationPort,
  TeamStore,
} from '../../team/ports.js';

interface FileVersion {
  identity: string;
  hash: string;
}
interface SourceFile {
  version: FileVersion;
  bytes: string;
}
interface Write {
  path: string;
  before?: FileVersion;
  after: FileVersion;
  stage: string;
}
interface Plan extends PreparedTaskMutation {
  schemaVersion: 1;
  fingerprint: string;
  commandId: string;
  source: Record<string, FileVersion>;
  directories: Record<string, string>;
  writes: Write[];
}

const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Only the JSON closure used by the exposed Task commands, never host/runtime state. */
export class TaskEffectPlan implements TaskMutationPort {
  constructor(
    private readonly root: string,
    private readonly teamName: string,
    private readonly store: TeamStore
  ) {
    safeSegment(teamName);
  }

  private key(receipt: CommandReceipt): string {
    return `task-plans/${digest(receipt.commandId)}.json`;
  }

  private allowed(path: string): boolean {
    const task = `tasks/${this.teamName}/`;
    const team = `teams/${this.teamName}/`;
    const leaf = (name: string): boolean => /^[A-Za-z0-9_-]+\.json$/.test(name);
    if (path.startsWith(task)) return leaf(path.slice(task.length));
    if (!path.startsWith(team)) return false;
    const name = path.slice(team.length);
    return (
      ['config.json', 'members.meta.json', 'kanban-state.json', 'sentMessages.json'].includes(
        name
      ) ||
      (name.startsWith('inboxes/') && leaf(name.slice('inboxes/'.length)))
    );
  }

  private identity(path: string, directory = false): string | undefined {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
        throw new TeamOwnerError('hold');
      return digest(
        directory
          ? [stat.dev, stat.ino, stat.birthtimeMs]
          : [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.size]
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private file(base: string, path: string): SourceFile | undefined {
    const absolute = join(base, path);
    const identity = this.identity(absolute);
    if (!identity) return undefined;
    const bytes = readFileSync(absolute, 'utf8');
    if (Buffer.byteLength(bytes) > MAX_BYTES || this.identity(absolute) !== identity)
      throw new TeamOwnerError('hold');
    return { bytes, version: { identity, hash: createHash('sha256').update(bytes).digest('hex') } };
  }

  private scan(base: string): Record<string, SourceFile> {
    const files: Record<string, SourceFile> = {};
    let bytes = 0;
    const collect = (relative: string, strict = false): void => {
      let entries;
      try {
        entries = readdirSync(join(base, relative), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = `${relative}/${entry.name}`;
        if (!this.allowed(path)) {
          // Canonical scans every visible JSON task/inbox. Never silently prepare
          // against a smaller product closure when a foreign filename is present.
          if (strict && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
            throw new TeamOwnerError('hold');
          continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) throw new TeamOwnerError('hold');
        const file = this.file(base, path);
        if (!file) throw new TeamOwnerError('hold');
        files[path] = file;
        bytes += Buffer.byteLength(file.bytes);
        if (Object.keys(files).length > MAX_FILES || bytes > MAX_BYTES)
          throw new TeamOwnerError('hold');
      }
    };
    collect(`tasks/${this.teamName}`, true);
    collect(`teams/${this.teamName}`);
    collect(`teams/${this.teamName}/inboxes`, true);
    return files;
  }

  private readPlan(receipt: CommandReceipt): Plan | undefined {
    const plan = this.store.read<Plan>(this.key(receipt));
    if (!plan) return undefined;
    if (
      plan.schemaVersion !== 1 ||
      plan.commandId !== receipt.commandId ||
      plan.fingerprint !== receipt.fingerprint ||
      !Array.isArray(plan.writes) ||
      plan.writes.length > MAX_FILES
    )
      throw new TeamOwnerError('hold');
    for (const write of plan.writes) {
      if (
        !this.allowed(write.path) ||
        dirname(write.stage) !== dirname(write.path) ||
        !write.stage.endsWith(
          `.host-task-${digest(receipt.commandId)}-${plan.writes.indexOf(write)}.stage`
        )
      )
        throw new TeamOwnerError('hold');
    }
    return plan;
  }

  load(receipt: CommandReceipt): PreparedTaskMutation | undefined {
    return this.readPlan(receipt);
  }

  prepare(
    receipt: CommandReceipt,
    actor: string,
    apply: (board: TaskBoardPolicy) => JsonValue
  ): PreparedTaskMutation {
    const previous = this.readPlan(receipt);
    if (previous) return previous;
    const source = this.scan(this.root);
    const work = join(this.root, 'teams', this.teamName, '.host-owner', 'task-work', randomUUID());
    // Only an unprepared private snapshot is disposable. No live product file is touched here.
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      for (const [path, file] of Object.entries(source)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), file.bytes, { flag: 'wx' });
      }
      const board = createTeamController(work, this.teamName, actor === 'user').taskBoard;
      let result: JsonValue;
      try {
        result = apply(board);
      } catch {
        throw new TaskPolicyRejected();
      }
      const taskId =
        receipt.command.operation === 'task.create'
          ? receipt.effects.taskId
          : receipt.command.operation === 'message.send'
            ? ''
            : receipt.command.payload.taskId;
      const taskHash = digest(board.getTask(taskId));
      const target = this.scan(work);
      for (const path of Object.keys(source)) if (!target[path]) throw new TeamOwnerError('hold');
      if (digest(this.scan(this.root)) !== digest(source)) throw new TeamOwnerError('hold');
      const writes: Write[] = [];
      // Product Task/board state precedes inbox publication; the complete plan is already durable.
      const changed = Object.keys(target)
        .filter((path) => source[path]?.bytes !== target[path]!.bytes)
        .sort(
          (a, b) =>
            Number(b.startsWith('tasks/')) - Number(a.startsWith('tasks/')) || a.localeCompare(b)
        );
      for (const path of changed) {
        mkdirSync(dirname(join(this.root, path)), { recursive: true });
        const stage = `${dirname(path)}/.host-task-${digest(receipt.commandId)}-${writes.length}.stage`;
        // Existing stage without a durable plan can only belong to this unprepared attempt.
        rmSync(join(this.root, stage), { force: true });
        writeFileSync(join(this.root, stage), target[path]!.bytes, { flag: 'wx', flush: true });
        const staged = this.file(this.root, stage);
        if (!staged) throw new TeamOwnerError('hold');
        writes.push({
          path,
          ...(source[path] ? { before: source[path]!.version } : {}),
          after: staged.version,
          stage,
        });
      }
      const directories: Record<string, string> = {};
      for (const path of [
        '',
        'teams',
        `teams/${this.teamName}`,
        `teams/${this.teamName}/inboxes`,
        'tasks',
        `tasks/${this.teamName}`,
      ]) {
        const identity = this.identity(join(this.root, path), true);
        if (identity) directories[path] = identity;
      }
      const { notifications, removedMessageIds } = this.notifications(source, target);
      const plan: Plan = {
        schemaVersion: 1,
        fingerprint: receipt.fingerprint,
        commandId: receipt.commandId,
        result,
        taskHash,
        notifications,
        removedMessageIds,
        writes,
        directories,
        source: Object.fromEntries(
          Object.entries(source).map(([path, file]) => [path, file.version])
        ),
      };
      this.store.write(this.key(receipt), plan);
      return plan;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private notifications(
    source: Record<string, SourceFile>,
    target: Record<string, SourceFile>
  ): Pick<Plan, 'notifications' | 'removedMessageIds'> {
    const notifications: Plan['notifications'] = [];
    const removedMessageIds: string[] = [];
    for (const [path, file] of Object.entries(target)) {
      if (!path.startsWith(`teams/${this.teamName}/inboxes/`)) continue;
      const before: unknown = JSON.parse(source[path]?.bytes ?? '[]');
      const after: unknown = JSON.parse(file.bytes);
      if (!Array.isArray(before) || !Array.isArray(after)) throw new TeamOwnerError('hold');
      const ids = new Set(before.map((row: Record<string, unknown>) => row.messageId));
      for (const row of after as Record<string, unknown>[]) {
        if (ids.has(row.messageId)) continue;
        if (
          row.source !== 'system_notification' ||
          typeof row.messageId !== 'string' ||
          typeof row.text !== 'string'
        )
          throw new TeamOwnerError('hold');
        notifications.push({
          member: path.slice(path.lastIndexOf('/') + 1, -5),
          messageId: row.messageId,
          content: row.text,
        });
      }
      const remaining = new Set(after.map((row: Record<string, unknown>) => row.messageId));
      for (const row of before as Record<string, unknown>[])
        if (!remaining.has(row.messageId) && typeof row.messageId === 'string')
          removedMessageIds.push(row.messageId);
    }
    return { notifications, removedMessageIds };
  }

  validate(receipt: CommandReceipt): void {
    const plan = this.readPlan(receipt);
    if (!plan) throw new TeamOwnerError('hold');
    this.check(plan);
  }

  private check(plan: Plan): void {
    for (const [path, identity] of Object.entries(plan.directories))
      if (this.identity(join(this.root, path), true) !== identity) throw new TeamOwnerError('hold');
    const current = this.scan(this.root);
    const expected = new Set([
      ...Object.keys(plan.source),
      ...plan.writes.map((write) => write.path),
    ]);
    if (Object.keys(current).some((path) => !expected.has(path))) throw new TeamOwnerError('hold');
    for (const path of expected) {
      const write = plan.writes.find((effect) => effect.path === path);
      const version = current[path]?.version;
      const before = write?.before ?? plan.source[path];
      if (write && digest(version ?? null) === digest(write.after)) continue;
      if (digest(version ?? null) !== digest(before ?? null)) throw new TeamOwnerError('hold');
      if (
        write &&
        digest(this.file(this.root, write.stage)?.version ?? null) !== digest(write.after)
      )
        throw new TeamOwnerError('hold');
    }
  }

  publish(receipt: CommandReceipt): void {
    const plan = this.readPlan(receipt);
    if (!plan) throw new TeamOwnerError('hold');
    this.check(plan);
    for (let index = 0; index < plan.writes.length; index++) {
      this.check(plan);
      const write = plan.writes[index]!;
      if (digest(this.file(this.root, write.path)?.version ?? null) === digest(write.after))
        continue;
      renameSync(join(this.root, write.stage), join(this.root, write.path));
      this.afterPublish(index, write.path);
    }
    this.check(plan);
  }

  /** Fault boundary for filesystem integration tests; production has no alternate publisher. */
  protected afterPublish(_index: number, _path: string): void {
    /* publication is synchronous */
  }
}
