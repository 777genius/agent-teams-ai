import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs, { mkdtemp, writeFile, mkdir, symlink, truncate, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  isDocumentPreviewable,
} from '../../../src/features/document-preview';
import { readDocumentPreview } from '../../../src/features/document-preview/main/infrastructure/readDocumentPreview';

function officeZip(payload = Buffer.from('<document/>'), declaredSize = payload.length): Buffer {
  const data = deflateRawSync(payload);
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

// These assertions go red if document reads escape the project, trust a renamed
// container, allocate oversized input, or mutate the source document.
describe('bounded local document transport', () => {
  let sandbox: string;
  let project: string;
  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-document-preview-'));
    project = path.join(sandbox, 'project');
    await mkdir(project);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(sandbox, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('rejects a regular file swapped to a FIFO before descriptor open', async () => {
    const file = path.join(project, 'swapped.pdf');
    await writeFile(file, '%PDF-1.7');
    const actualOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.unlink(file);
      await promisify(execFile)('mkfifo', [file]);
      return actualOpen(...args);
    });
    const reading = readDocumentPreview(project, file);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIFO read timed out')), 1000);
      });
      await expect(Promise.race([reading, timeout])).rejects.toThrow('Path changed during read');
    } finally {
      clearTimeout(timer);
      const release = await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK);
      await release.close();
      await reading.catch(() => undefined);
    }
  });

  it('returns exact binary bytes and a basename without changing the source', async () => {
    const file = path.join(project, 'report.PDF');
    const bytes = Buffer.from('%PDF-1.7\n\x00binary\xff');
    await writeFile(file, bytes);
    const result = await readDocumentPreview(project, file);
    expect(result.format).toBe('pdf');
    expect(result.fileName).toBe('report.PDF');
    expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(await readFile(file)).toEqual(bytes);
  });

  it('accepts only supported non-macro OpenXML containers', async () => {
    for (const extension of ['docx', 'xlsx', 'pptx']) {
      const file = path.join(project, 'sample.' + extension);
      await writeFile(file, officeZip());
      expect((await readDocumentPreview(project, file)).format).toBe(extension);
    }
    expect(isDocumentPreviewable('sample.docm', 1024)).toBe(false);
    expect(isDocumentPreviewable('sample.html', 1024)).toBe(false);
  });

  it('rejects encrypted or damaged inputs and empty documents', async () => {
    const file = path.join(project, 'sample.docx');
    await writeFile(file, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    await expect(readDocumentPreview(project, file)).rejects.toThrow('encrypted');
    await writeFile(file, '');
    await expect(readDocumentPreview(project, file)).rejects.toThrow('Empty');
  });

  it('rejects oversized input before reading document bytes', async () => {
    const file = path.join(project, 'large.pdf');
    await writeFile(file, '%PDF-1.7');
    await truncate(file, DOCUMENT_PREVIEW_MAX_BYTES + 1);
    await expect(readDocumentPreview(project, file)).rejects.toThrow('20 MB');
    expect(isDocumentPreviewable('large.pdf', DOCUMENT_PREVIEW_MAX_BYTES + 1)).toBe(false);
  });

  it('previews safe in-project symlinks while keeping their display basename', async () => {
    const file = path.join(project, 'target.txt');
    const link = path.join(project, 'linked.pdf');
    await writeFile(file, '%PDF-1.7\nsafe target');
    await symlink(file, link);
    const result = await readDocumentPreview(project, link);
    expect(result.fileName).toBe('linked.pdf');
    expect(Buffer.from(result.bytes).toString()).toBe('%PDF-1.7\nsafe target');
  });

  it('blocks direct access outside the active project and both symlink escapes', async () => {
    const outside = path.join(sandbox, 'outside.pdf');
    await writeFile(outside, '%PDF-1.7');
    await expect(readDocumentPreview(project, outside)).rejects.toThrow();
    await symlink(outside, path.join(project, 'link.pdf'));
    await expect(readDocumentPreview(project, path.join(project, 'link.pdf'))).rejects.toThrow();
    await symlink(sandbox, path.join(project, 'linked-directory'));
    await expect(
      readDocumentPreview(project, path.join(project, 'linked-directory', 'outside.pdf'))
    ).rejects.toThrow();
  });

  it('rejects ZIP bombs even when central-directory sizes lie', async () => {
    const file = path.join(project, 'bomb.docx');
    await writeFile(file, officeZip(Buffer.from('EXPANDED'.repeat(10_000)), 1));
    await expect(readDocumentPreview(project, file)).rejects.toThrow('decompression');
    await writeFile(file, officeZip(Buffer.from('small'), 65 * 1024 * 1024));
    await expect(readDocumentPreview(project, file)).rejects.toThrow('oversized');
    await writeFile(file, Buffer.from([0x50, 0x4b, 3, 4, 0, 1]));
    await expect(readDocumentPreview(project, file)).rejects.toThrow('ZIP directory');
  });

  it('validates runtime payloads instead of trusting preload typing', async () => {
    await expect(readDocumentPreview(project, null)).rejects.toThrow('Invalid');
    await expect(readDocumentPreview(project, 'relative.pdf')).rejects.toThrow('Invalid');
    await expect(readDocumentPreview(project, project)).rejects.toThrow();
  });
});
