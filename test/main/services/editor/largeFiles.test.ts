import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }));

import { boundedTextRead } from '../../../../src/main/services/editor/boundedTextRead';
import { checkFileConflict } from '../../../../src/main/services/editor/conflictDetection';
import { ProjectFileService } from '../../../../src/main/services/editor/ProjectFileService';

let root: string;
const service = new ProjectFileService();
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-large-test-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

// Regressions: the former 5MiB rejection/2MiB write ceiling, truncated editable text,
// split UTF-8 at a bounded preview, growth beyond the read budget, and preview overwrite.
describe('large editor files on disk', () => {
  it.skipIf(process.platform === 'win32')('rejects a FIFO promptly instead of blocking before the type check', async () => {
    const fifo = path.join(root, 'pipe');
    await promisify(execFile)('mkfifo', [fifo]);
    const reading = boundedTextRead(fifo);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIFO read timed out')), 1000);
      });
      await expect(Promise.race([reading, timeout])).rejects.toThrow('Not a regular file');
    } finally {
      clearTimeout(timer);
      // Unblock an old blocking implementation so a failing test cannot leak a libuv worker.
      const release = await fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      await release.close();
      await reading.catch(() => undefined);
    }
  });

  // These fail if safe links are rejected/replaced, or canonical targets bypass containment.
  it('opens and saves an in-project file symlink without replacing the link', async () => {
    const target = path.join(root, 'target.txt');
    const link = path.join(root, 'link.txt');
    await fs.writeFile(target, 'original');
    await fs.symlink('target.txt', link);
    const opened = await service.readFile(root, link);
    expect(opened.content).toBe('original');
    const saved = await service.writeFile(root, link, 'edited through link');
    expect(await fs.readFile(target, 'utf8')).toBe('edited through link');
    expect(await fs.readlink(link)).toBe('target.txt');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(saved.mtimeMs).toBe((await fs.stat(target)).mtimeMs);
    expect((await checkFileConflict(link, opened.mtimeMs - 2000)).hasConflict).toBe(true);
  });

  it('rejects reads and saves through a file symlink to an existing external target', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-outside-test-'));
    try {
      const target = path.join(outside, 'outside.txt');
      const link = path.join(root, 'escape.txt');
      await fs.writeFile(target, 'outside project');
      await fs.symlink(target, link);
      await expect(service.readFile(root, link)).rejects.toThrow('outside allowed directories');
      await expect(service.writeFile(root, link, 'must not write')).rejects.toThrow('outside allowed directories');
      expect(await fs.readFile(target, 'utf8')).toBe('outside project');
      expect(await fs.readlink(link)).toBe(target);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('still supports creating a missing regular file', async () => {
    const file = path.join(root, 'new.txt');
    await service.writeFile(root, file, 'new content');
    expect((await service.readFile(root, file)).content).toBe('new content');
  });

  it('opens and saves safe links when the project root is itself a directory symlink', async () => {
    const directory = path.join(root, 'project');
    const projectLink = path.join(root, 'project-link');
    await fs.mkdir(directory);
    await fs.symlink(directory, projectLink, 'dir');
    await fs.writeFile(path.join(directory, 'target.txt'), 'original');
    await fs.symlink('target.txt', path.join(directory, 'link.txt'));
    const file = path.join(projectLink, 'link.txt');
    expect((await service.readFile(projectLink, file)).content).toBe('original');
    await service.writeFile(projectLink, file, 'edited');
    expect(await fs.readFile(path.join(directory, 'target.txt'), 'utf8')).toBe('edited');
    expect(await fs.readlink(path.join(directory, 'link.txt'))).toBe('target.txt');
  });

  it('rejects a file link swapped after descriptor open', async () => {
    const target = path.join(root, 'target.txt');
    const replacement = path.join(root, 'replacement.txt');
    const link = path.join(root, 'link.txt');
    await fs.writeFile(target, 'original');
    await fs.writeFile(replacement, 'replacement');
    await fs.symlink(target, link);
    const actualOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args);
      if (args[0] === target) { await fs.unlink(link); await fs.symlink(replacement, link); }
      return handle;
    });
    await expect(service.readFile(root, link)).rejects.toThrow('Path changed during read');
  });

  it('rejects a link swapped while an atomic save is being prepared', async () => {
    const target = path.join(root, 'target.txt');
    const replacement = path.join(root, 'replacement.txt');
    const link = path.join(root, 'link.txt');
    await fs.writeFile(target, 'original');
    await fs.writeFile(replacement, 'replacement');
    await fs.symlink(target, link);
    const actualOpen = fs.open;
    // atomicWrite uses fs.promises.open for its private temporary file.
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args);
      if (path.basename(String(args[0])).startsWith('.tmp.')) {
        await fs.unlink(link); await fs.symlink(replacement, link);
      }
      return handle;
    });
    await expect(service.writeFile(root, link, 'must not publish')).rejects.toThrow('Path changed during write');
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await fs.readFile(replacement, 'utf8')).toBe('replacement');
  });

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
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-outside-test-'));
    try {
      await fs.writeFile(path.join(outside, 'outside.txt'), 'outside project');
      await fs.symlink(outside, path.join(root, 'escape'));
      await expect(service.readFile(root, path.join(root, 'escape', 'outside.txt')))
        .rejects.toThrow('Path is outside allowed directories');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
