import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }));

import { ProjectFileService } from '../../../../src/main/services/editor/ProjectFileService';
import { boundedTextRead } from '../../../../src/main/services/editor/boundedTextRead';
import { checkFileConflict } from '../../../../src/main/services/editor/conflictDetection';

let root: string;
const service = new ProjectFileService();
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-large-test-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

// Regressions: the former 5MiB rejection/2MiB write ceiling, truncated editable text,
// split UTF-8 at a bounded preview, growth beyond the read budget, and preview overwrite.
describe('large editor files on disk', () => {
  it('opens and saves every byte of a 20MiB file, retaining its tail and conflict baseline', async () => {
    const file = path.join(root, 'large.txt');
    const text = 'start\n' + 'x\n'.repeat(10 * 1024 * 1024) + 'TAIL-完整';
    await fs.writeFile(file, text);
    const opened = await service.readFile(root, file);
    expect(opened.mode).toBe('large');
    expect(opened.truncated).toBe(false);
    expect(digest(opened.content)).toBe(digest(text));
    const edited = 'edited\n' + opened.content;
    await service.writeFile(root, file, edited);
    expect(digest(await fs.readFile(file))).toBe(digest(edited));
    await fs.utimes(file, new Date(), new Date(opened.mtimeMs + 2000));
    expect((await checkFileConflict(file, opened.mtimeMs)).hasConflict).toBe(true);
  });

  it('supports the inclusive 32MiB byte boundary and rejects oversized UTF-8 writes', async () => {
    const file = path.join(root, 'boundary.txt');
    const text = 'a'.repeat(32 * 1024 * 1024);
    await fs.writeFile(file, text);
    expect((await service.readFile(root, file)).content.length).toBe(text.length);
    await service.writeFile(root, file, text);
    await expect(service.writeFile(root, file, text + '界')).rejects.toThrow('Content too large');
    expect((await fs.stat(file)).size).toBe(text.length);
  });

  it('returns a bounded read-only UTF-8 preview and refuses to overwrite the original', async () => {
    const file = path.join(root, 'oversized.txt');
    const head = Buffer.from('a'.repeat(256 * 1024 - 1) + '界TAIL');
    await fs.writeFile(file, head);
    await fs.truncate(file, 33 * 1024 * 1024);
    const opened = await service.readFile(root, file);
    expect(opened.mode).toBe('preview');
    expect(opened.truncated).toBe(true);
    expect(opened.content).toBe('a'.repeat(256 * 1024 - 1));
    expect(opened.content).not.toContain('\uFFFD');
    await expect(service.writeFile(root, file, opened.content)).rejects.toThrow('Read-only');
    expect((await fs.stat(file)).size).toBe(33 * 1024 * 1024);
    expect((await fs.readFile(file)).subarray(0, head.length)).toEqual(head);
  });

  it('classifies oversized binary files before reading the whole document', async () => {
    const file = path.join(root, 'binary.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 0, 2]));
    await fs.truncate(file, 33 * 1024 * 1024);
    expect(await service.readFile(root, file)).toMatchObject({ isBinary: true, mode: 'binary', content: '' });
  });

  it('does not trust the initial size when a file grows during a read', async () => {
    const file = path.join(root, 'growth.txt');
    await fs.writeFile(file, 'abc');
    const actualOpen = fs.open;
    let requested = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args);
      const read = handle.read.bind(handle);
      let first = true;
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        if (first) { first = false; await fs.writeFile(file, 'x'.repeat(40 * 1024 * 1024)); }
        const result = await read(...readArgs);
        requested += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    });
    await expect(boundedTextRead(file)).rejects.toThrow('File changed during read');
    expect(requested).toBeGreaterThan(32 * 1024 * 1024);
    expect(requested).toBeLessThanOrEqual(32 * 1024 * 1024 + 1);
  });

  it('preserves sensitive-path and symlink escape checks', async () => {
    await fs.writeFile(path.join(root, '.env'), 'secret');
    await expect(service.readFile(root, path.join(root, '.env'))).rejects.toThrow();
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
    await expect(service.readFile(root, path.join(root, 'escape', 'outside'))).rejects.toThrow();
  });
});
