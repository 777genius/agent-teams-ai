import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isDevicePath, isGitInternalPath, isPathWithinRoot, validateFilePath } from '@main/utils/pathValidation';
import { getDocumentFormat } from '@features/document-preview';
import { EDITOR_FULL_MAX_BYTES, EDITOR_PREVIEW_MAX_BYTES, EDITOR_REDUCED_MODE_BYTES } from '@shared/editorPolicy';
import fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';

import type { ReadFileResult } from '@shared/types/editor';

/** Resolve safe links before opening or publishing, retaining the original link on save. */
export async function resolveEditorFilePath(
  projectRoot: string, filePath: string, writing = false
): Promise<string> {
  let target: string;
  try {
    target = await fs.realpath(filePath);
  } catch (error) {
    if (!writing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Only allow a genuinely absent file, never a dangling symlink.
    try {
      await fs.lstat(filePath);
      throw new Error('Not a regular file');
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
    }
    target = path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
  }
  const canonicalRoot = await fs.realpath(projectRoot);
  const validation = validateFilePath(target, canonicalRoot);
  if (!validation.valid) throw new Error(validation.error);
  if (isDevicePath(target)) throw new Error('Cannot access device files');
  if (writing) {
    if (!isPathWithinRoot(target, canonicalRoot)) {
      throw new Error('Path is outside project root');
    }
    if (isGitInternalPath(target)) throw new Error('Cannot write to .git/ directory');
  }
  return target;
}

/** Repeat containment and mapping checks at the read/publish boundary. */
export async function assertEditorFilePathUnchanged(
  projectRoot: string, filePath: string, target: string, writing = false
): Promise<void> {
  try {
    if (await resolveEditorFilePath(projectRoot, filePath, writing) === target) return;
  } catch { /* Report a uniform race error instead of returning data from a changed path. */ }
  throw new Error(`Path changed during ${writing ? 'write' : 'read'} (TOCTOU)`);
}

/** Read through one descriptor, with an actual byte ceiling even if the path grows. */
export async function boundedTextRead(filePath: string): Promise<ReadFileResult> {
  // Nonblocking open reaches the type check even if a validated path became a FIFO.
  const handle = await fs.open(filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Not a regular file');
    const preview = before.size > EDITOR_FULL_MAX_BYTES;
    const budget = preview ? EDITOR_PREVIEW_MAX_BYTES : EDITOR_FULL_MAX_BYTES + 1;
    const chunks: Buffer[] = [];
    const head = Buffer.allocUnsafe(512);
    const first = await handle.read(head, 0, head.length, 0);
    const binary = getDocumentFormat(filePath) !== null || await isBinaryFile(head.subarray(0, first.bytesRead));
    let length = first.bytesRead;
    chunks.push(head.subarray(0, length));
    while (!binary && length < budget) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, budget - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(filePath);
    if (before.dev !== current.dev || before.ino !== current.ino || !current.isFile()) {
      throw new Error('Path changed during read (TOCTOU)');
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      throw new Error('File changed during read. Please retry.');
    }
    const raw = Buffer.concat(chunks, length);
    if (binary) return { content: '', size: after.size, mtimeMs: after.mtimeMs,
      truncated: false, encoding: 'binary', isBinary: true, mode: 'binary' };
    // A sentinel byte proves a document exceeds the full budget. Never expose partial text as editable.
    const truncated = preview || length > EDITOR_FULL_MAX_BYTES;
    const bytes = truncated ? raw.subarray(0, EDITOR_PREVIEW_MAX_BYTES) : raw;
    const decoder = new StringDecoder('utf8');
    // Do not flush an incomplete final UTF-8 character at the preview boundary.
    const content = decoder.write(bytes) + (truncated ? '' : decoder.end());
    return { content, size: after.size, mtimeMs: after.mtimeMs, truncated,
      encoding: 'utf-8', isBinary: false,
      mode: truncated ? 'preview' : length >= EDITOR_REDUCED_MODE_BYTES ? 'large' : 'full' };
  } finally {
    await handle.close();
  }
}
