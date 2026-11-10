import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { digest } from '../team/identity.js';
import type { TaskToolEvidenceBinding } from './bindTaskToolEvidence.js';
import type { RuntimeInputEvidenceBinding } from './bindRuntimeInputEvidence.js';
import type { FileImage, NativeFileEffectProof } from './captureContracts.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function writeAll(handle: number, bytes: Buffer, guard: () => void): void {
  let offset = 0;
  while (offset < bytes.length) {
    guard();
    const wrote = writeSync(handle, bytes, offset, bytes.length - offset);
    if (!wrote) throw new Error('Incomplete evidence write');
    offset += wrote;
  }
}
function segment(taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  return !encoded ||
    encoded.length > 120 ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(encoded)
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded;
}
/** Writes existing portable V1 journals; caller owns synchronous generation/storage fencing. */
export class TaskEvidenceJournal {
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Invalid ledger namespace');
  }
  private directory(directory: string, guard: () => void): void {
    let current = parse(directory).root;
    for (const part of directory.slice(current.length).split(sep)) {
      current = join(current, part);
      guard();
      try {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Unsafe ledger namespace');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        guard();
        mkdirSync(current, { mode: 0o700 });
      }
    }
  }
  private append(
    kind: 'events' | 'notices',
    binding: RuntimeInputEvidenceBinding,
    row: Record<string, unknown>,
    guard: () => void
  ): void {
    const directory =
      'taskId' in binding
        ? join(this.root, '.board-task-changes', kind)
        : join(this.root, '.board-task-changes', 'agents', segment(binding.binding.memberId));
    this.directory(directory, guard);
    const file = join(
      directory,
      'taskId' in binding ? `${segment(binding.taskId)}.jsonl` : `${kind}.jsonl`
    );
    guard();
    const handle = openSync(
      file,
      constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const info = fstatSync(handle);
      const encoded = Buffer.from(`${JSON.stringify(row)}\n`);
      if (!info.isFile() || info.size + encoded.length > 16 * 1024 * 1024)
        throw new Error('Ledger partial or capped');
      const existing = readFileSync(handle, 'utf8');
      if (Buffer.byteLength(existing) > 16 * 1024 * 1024 || (existing && !existing.endsWith('\n')))
        throw new Error('Ledger partial or capped');
      const key = kind === 'events' ? 'eventId' : 'noticeId';
      if (
        existing
          .split('\n')
          .filter(Boolean)
          .some((line) => (JSON.parse(line) as Record<string, unknown>)[key] === row[key])
      )
        return;
      guard();
      writeAll(handle, encoded, guard);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }
  private base(binding: RuntimeInputEvidenceBinding & { readonly toolUseId?: string }) {
    return {
      schemaVersion: 1,
      ...('taskId' in binding
        ? { taskId: binding.taskId, taskRef: binding.taskId, taskRefKind: 'canonical' }
        : { artifactKind: 'agent-input', inputId: binding.inputId, messageId: binding.messageId }),
      phase: 'work',
      executionSeq: 0,
      sessionId: binding.sessionRef,
      agentId: binding.binding.memberId,
      ...('toolUseId' in binding ? { toolUseId: binding.toolUseId } : {}),
      timestamp: new Date().toISOString(),
      evidenceProof: digest(binding),
      causalBinding: binding,
    };
  }
  image(value: FileImage, guard: () => void) {
    if (value.exists === false) return { ref: null, state: { exists: false } };
    if (!value.content)
      return {
        ref: null,
        state: {
          ...(value.exists === undefined ? {} : { exists: value.exists }),
          ...(value.sha256 ? { sha256: value.sha256 } : {}),
          unavailableCode: 'not-captured',
          unavailableReason: value.reason ?? 'not-captured',
        },
      };
    const sha256 = hash(value.content);
    const directory = join(this.root, '.board-task-changes', 'blobs');
    this.directory(directory, guard);
    const file = join(directory, `${sha256}.txt`);
    guard();
    let handle: number | undefined;
    try {
      handle = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      writeAll(handle, value.content, guard);
      fsyncSync(handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== value.content.length ||
        hash(readFileSync(file)) !== sha256
      )
        throw new Error('Invalid existing evidence blob');
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
    const ref = { sha256, sizeBytes: value.content.length, blobRef: `${sha256}.txt` };
    return { ref, state: { exists: true, ...ref, contentKind: 'text' } };
  }
  notice(
    binding: RuntimeInputEvidenceBinding,
    id: string,
    message: string,
    guard: () => void,
    extra: Record<string, unknown> = {}
  ): void {
    this.append(
      'notices',
      binding,
      {
        ...this.base(binding),
        noticeId: digest({ id, binding }),
        severity: 'warning',
        message,
        ...extra,
      },
      guard
    );
  }
  event(
    binding: TaskToolEvidenceBinding,
    file: string,
    before: FileImage,
    after: FileImage,
    status: 'succeeded' | 'failed',
    warnings: readonly string[],
    guard: () => void,
    nativeCaptureProof?: NativeFileEffectProof
  ): void {
    const old = this.image(before, guard),
      next = this.image(after, guard);
    this.append(
      'events',
      binding,
      {
        ...this.base(binding),
        eventId: digest({ binding, file }),
        ...(nativeCaptureProof ? { nativeCaptureProof } : {}),
        source:
          binding.toolName === 'Bash' || binding.toolName === 'PowerShell'
            ? 'shell_snapshot'
            : binding.toolName === 'Write'
              ? 'file_write'
              : 'file_edit',
        operation:
          before.exists === false ? 'create' : after.exists === false ? 'delete' : 'modify',
        confidence: warnings.length ? 'low' : 'exact',
        workspaceRoot: binding.workspace.path,
        filePath: file,
        relativePath: relative(binding.workspace.path, file).split(sep).join('/'),
        toolStatus: status,
        before: old.ref,
        after: next.ref,
        beforeState: old.state,
        afterState: next.state,
        warnings,
      },
      guard
    );
  }
}
