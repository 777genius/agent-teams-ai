import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isDevicePath, isPathWithinRoot, validateFilePath } from '@main/utils/pathValidation';

import { DOCUMENT_PREVIEW_MAX_BYTES, getDocumentFormat } from '../../core/domain/documentPolicy';

import { validateOfficeArchive } from './validateOfficeArchive';

import type { DocumentPreviewResult } from '../../contracts';

/** Read only a regular file inside the active project, through one bounded descriptor. */
export async function readDocumentPreview(
  projectRoot: string,
  input: unknown
): Promise<DocumentPreviewResult> {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Invalid file path');
  const validation = validateFilePath(input, projectRoot);
  if (!validation.valid || !validation.normalizedPath) throw new Error(validation.error);
  const filePath = validation.normalizedPath;
  if (isDevicePath(filePath) || !isPathWithinRoot(filePath, projectRoot)) {
    throw new Error('Document must be inside the active project');
  }
  const format = getDocumentFormat(filePath);
  if (!format) throw new Error('Unsupported document format');
  const root = await fs.realpath(projectRoot);
  const realPath = await fs.realpath(filePath);
  if (
    !isPathWithinRoot(realPath, root, { preserveCase: true }) ||
    isDevicePath(realPath) ||
    !validateFilePath(realPath, root).valid
  ) {
    throw new Error('Document must be inside the active project');
  }
  const entry = await fs.lstat(realPath);
  if (!entry.isFile()) throw new Error('Not a regular file');
  const handle = await fs.open(realPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino) {
      throw new Error('Path changed during read');
    }
    if (before.size === 0) throw new Error('Empty document');
    if (before.size > DOCUMENT_PREVIEW_MAX_BYTES)
      throw new Error('Document exceeds the 20 MB preview limit');
    const buffer = Buffer.alloc(before.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        Math.min(64 * 1024, buffer.length - length),
        length
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(realPath);
    if (
      length !== before.size ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      !current.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      (await fs.realpath(filePath)) !== realPath ||
      (await fs.realpath(projectRoot)) !== root
    ) {
      throw new Error('Document changed during read. Please retry.');
    }
    // Validate the container before dispatching to third-party parsers. Encrypted Office
    // documents use the OLE container and intentionally fall back to the system viewer.
    const validSignature =
      format === 'pdf'
        ? buffer.subarray(0, 5).toString() === '%PDF-'
        : buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 3 && buffer[3] === 4;
    if (!validSignature) throw new Error('Unsupported, encrypted, or damaged document');
    if (format !== 'pdf') await validateOfficeArchive(buffer);
    return { bytes: new Uint8Array(buffer), fileName: path.basename(filePath), format };
  } finally {
    await handle.close();
  }
}
