import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { requireCapturedRuntimeInteraction } from './CapturedRuntimeInteraction.js';
import { capturedWorkspaceIdentity as identity } from './capturedWorkspaceIdentity.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';

interface Workspace {
  binding: string;
  path: string;
  configuredPath: string;
  identity: string;
  source: string;
}
export interface InteractionPreview {
  file: {
    attachment: { id: string; filename: string; mimeType: string; size: number };
    sha256: string;
    offset: number;
    base64: string;
    nextOffset: number | null;
  } | null;
  sourceFingerprint: string;
  exists: boolean;
  truncated: boolean;
  isBinary: boolean;
}
const MAX_BYTES = 2 * 1024 * 1024;
const stamp = (value: Stats) =>
  runtimeDigest({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtime: value.mtimeMs,
    ctime: value.ctimeMs,
  });
const source = (entry: MemberEntry) =>
  runtimeDigest({ binding: entry.binding, config: entry.config, profile: entry.profile });

/** Read grant derives only from this originally opened member workspace and pending request. */
export class CapturedInteractionPreview {
  private readonly workspaces = new WeakMap<MemberEntry, Workspace>();

  capture(entry: MemberEntry): void {
    const configuredPath = entry.profile.cwd;
    if (!isAbsolute(configuredPath)) throw new RuntimeOwnerError('invalid');
    const path = realpathSync(configuredPath);
    const captured = { binding: runtimeDigest(entry.binding), path, configuredPath, identity: identity(path), source: source(entry) };
    const previous = this.workspaces.get(entry);
    if (previous?.binding === captured.binding && runtimeDigest(previous) !== runtimeDigest(captured))
      throw new RuntimeOwnerError('conflict');
    this.workspaces.set(entry, captured);
  }

  read(options: {
    runtime: Pick<RuntimeOwner, 'readSession' | 'readActivitySnapshot'>;
    entry: MemberEntry;
    input: {
      inputId: string;
      interactionRef: string;
      offset: number;
      expectedSha256?: string | undefined;
      expectedSource?: string | undefined;
    };
    authoritySource?: string;
    assertCurrent(): void;
  }): InteractionPreview {
    const { entry } = options;
    const workspace = this.workspaces.get(entry);
    const assertCurrent = () => {
      options.assertCurrent();
      if (
        !workspace ||
        workspace.source !== source(entry) ||
        workspace.configuredPath !== entry.profile.cwd ||
        realpathSync(workspace.configuredPath) !== workspace.path ||
        identity(workspace.path) !== workspace.identity
      )
        throw new RuntimeOwnerError('hold');
    };
    assertCurrent();
    const captured = requireCapturedRuntimeInteraction(
      options.runtime,
      entry,
      options.input,
      assertCurrent
    );
    if (
      captured.request.kind !== 'permission' ||
      !['Write', 'Edit', 'NotebookEdit'].includes(captured.request.tool) ||
      !captured.request.input ||
      typeof captured.request.input !== 'object' ||
      Array.isArray(captured.request.input)
    )
      throw new RuntimeOwnerError('invalid');
    const input = captured.request.input as Record<string, unknown>;
    const requestedPath = input.file_path ?? input.notebook_path;
    if (
      typeof requestedPath !== 'string' ||
      requestedPath.includes('\0') ||
      !isAbsolute(requestedPath) ||
      requestedPath.length > 8192
    )
      throw new RuntimeOwnerError('invalid');
    let path = resolve(requestedPath);
    const configuredTail = relative(resolve(workspace!.configuredPath), path);
    if (
      configuredTail &&
      configuredTail !== '..' &&
      !configuredTail.startsWith(`..${sep}`) &&
      !isAbsolute(configuredTail)
    )
      path = resolve(workspace!.path, configuredTail);
    const tail = relative(workspace!.path, path);
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail))
      throw new RuntimeOwnerError('forbidden');
    const ancestors: { path: string; value: string }[] = [];
    let cursor = workspace!.path;
    const parts = tail.split(sep);
    for (const part of parts.slice(0, -1)) {
      cursor = resolve(cursor, part);
      const info = lstatSync(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(cursor) !== cursor)
        throw new RuntimeOwnerError('hold');
      ancestors.push({ path: cursor, value: runtimeDigest({ dev: info.dev, ino: info.ino }) });
    }
    const verify = () => {
      assertCurrent();
      for (const ancestor of ancestors)
        if (identity(ancestor.path) !== ancestor.value) throw new RuntimeOwnerError('hold');
      const latest = requireCapturedRuntimeInteraction(
        options.runtime,
        entry,
        options.input,
        assertCurrent
      );
      if (runtimeDigest(latest) !== runtimeDigest(captured))
        throw new RuntimeOwnerError('conflict');
    };
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      verify();
      if (
        options.input.offset !== 0 ||
        options.input.expectedSource !== undefined ||
        options.input.expectedSha256 !== undefined
      )
        throw new RuntimeOwnerError('conflict');
      return {
        file: null,
        sourceFingerprint: runtimeDigest({ workspace, captured, authority: options.authoritySource ?? null, exists: false }),
        exists: false,
        truncated: false,
        isBinary: false,
      };
    }
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path)
      throw new RuntimeOwnerError('hold');
    const before = stamp(info);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(fstatSync(fd)) !== before) throw new RuntimeOwnerError('conflict');
      verify();
      if (stamp(lstatSync(path)) !== before) throw new RuntimeOwnerError('conflict');
      const bytes = Buffer.alloc(Math.min(info.size, MAX_BYTES));
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, read);
        if (!count) throw new RuntimeOwnerError('hold');
        read += count;
      }
      if (stamp(fstatSync(fd)) !== before || stamp(lstatSync(path)) !== before)
        throw new RuntimeOwnerError('conflict');
      verify();
      const isBinary = bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
      const fingerprint = runtimeDigest({ workspace, captured, authority: options.authoritySource ?? null, file: before });
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (
        (options.input.expectedSource !== undefined &&
          options.input.expectedSource !== fingerprint) ||
        (options.input.expectedSha256 !== undefined && options.input.expectedSha256 !== hash) ||
        options.input.offset > bytes.length ||
        (options.input.offset > 0 &&
          (!options.input.expectedSource || !options.input.expectedSha256))
      )
        throw new RuntimeOwnerError('conflict');
      const end = Math.min(bytes.length, options.input.offset + 384 * 1024);
      return {
        file: isBinary
          ? null
          : {
              attachment: {
                id: 'preview',
                filename: 'preview',
                mimeType: 'text/plain',
                size: bytes.length,
              },
              sha256: hash,
              offset: options.input.offset,
              base64: bytes.subarray(options.input.offset, end).toString('base64'),
              nextOffset: end < bytes.length ? end : null,
            },
        sourceFingerprint: fingerprint,
        exists: true,
        truncated: !isBinary && info.size > MAX_BYTES,
        isBinary,
      };
    } finally {
      closeSync(fd);
    }
  }
}
