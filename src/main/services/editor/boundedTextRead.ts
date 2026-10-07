import { constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { EDITOR_FULL_MAX_BYTES, EDITOR_PREVIEW_MAX_BYTES, EDITOR_REDUCED_MODE_BYTES } from '@shared/editorPolicy';
import fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';

import type { ReadFileResult } from '@shared/types/editor';

/** Read through one descriptor, with an actual byte ceiling even if the path grows. */
export async function boundedTextRead(filePath: string): Promise<ReadFileResult> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Not a regular file');
    const preview = before.size > EDITOR_FULL_MAX_BYTES;
    const budget = preview ? EDITOR_PREVIEW_MAX_BYTES : EDITOR_FULL_MAX_BYTES + 1;
    const chunks: Buffer[] = [];
    const head = Buffer.allocUnsafe(512);
    const first = await handle.read(head, 0, head.length, 0);
    const binary = await isBinaryFile(head.subarray(0, first.bytesRead));
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
