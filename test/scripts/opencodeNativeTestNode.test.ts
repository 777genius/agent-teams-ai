import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stageNativeTestNode } from '../../scripts/e2e/opencode-native-test-node';

const fakeBytes = Buffer.from('TEST fake Node bytes; never executable');
describe('TEST Node dependency staging without execution', () => {
  let root: string, source: string, project: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-node-staging-')));
    const sourceDirectory = path.join(root, 'TEST-source');
    project = path.join(root, 'TEST-project');
    await mkdir(sourceDirectory);
    await mkdir(project);
    source = path.join(sourceDirectory, 'node.exe');
    await writeFile(source, fakeBytes);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies fake bytes into a fresh distinct regular file and verifies both original identities', async () => {
    const result = await stageNativeTestNode(source, project);
    expect(result.executable).toBe(path.join(project, 'TEST-node-runtime', 'node.exe'));
    expect(result.bytes).toBe(fakeBytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(fakeBytes).digest('hex'));
    expect(await readFile(result.executable)).toEqual(fakeBytes);
    const [original, copied] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(result.executable, { bigint: true }),
    ]);
    expect(original.nlink).toBe(1n);
    expect(copied.nlink).toBe(1n);
    expect(original.ino === copied.ino && original.dev === copied.dev).toBe(false);
    await expect(result.verify()).resolves.toBeUndefined();
    await expect(stageNativeTestNode(source, project)).rejects.toThrow();
    expect(await readFile(result.executable)).toEqual(fakeBytes);
  });

  it('refuses an original source within the admitted project', async () => {
    const inside = path.join(project, 'node.exe');
    await writeFile(inside, fakeBytes);
    await expect(stageNativeTestNode(inside, project)).rejects.toThrow('outside the project');
    expect(await readFile(inside)).toEqual(fakeBytes);
  });

  it('accepts copy-only ctime metadata changes without refreshing bytes or identity', async () => {
    const result = await stageNativeTestNode(source, project);
    const before = await lstat(result.executable, { bigint: true });
    // Rename and return the same fake file: metadata changes, content/mode do not.
    await rename(result.executable, `${result.executable}.metadata`);
    await rename(`${result.executable}.metadata`, result.executable);
    const after = await lstat(result.executable, { bigint: true });
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.birthtimeNs).toBe(before.birthtimeNs);
    await expect(result.verify()).resolves.toBeUndefined();
    expect(await readFile(result.executable)).toEqual(fakeBytes);
  });

  it('keeps copied permission mode pinned even when bytes remain unchanged', async () => {
    const result = await stageNativeTestNode(source, project);
    await chmod(result.executable, 0o444);
    await expect(result.verify()).rejects.toThrow('staged copy changed');
    await chmod(result.executable, 0o700);
  });

  it('keeps original source permission metadata pinned', async () => {
    const result = await stageNativeTestNode(source, project);
    await chmod(source, 0o444);
    await expect(result.verify()).rejects.toThrow('source changed');
    await chmod(source, 0o600);
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts a real inherited-ACL-style Windows metadata transition on the owned fake copy',
    async () => {
      const result = await stageNativeTestNode(source, project);
      const before = await lstat(result.executable, { bigint: true });
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      expect(path.isAbsolute(systemRoot)).toBe(true);
      // Only the operating system ACL tool runs. The fake Node bytes never execute.
      await new Promise<void>((resolve, reject) => {
        execFile(
          path.join(systemRoot, 'System32', 'icacls.exe'),
          [result.executable, '/grant', '*S-1-1-0:(RX)'],
          { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
          (error) =>
            error ? reject(new Error('TEST owned copy ACL transition failed')) : resolve()
        );
      });
      const after = await lstat(result.executable, { bigint: true });
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.birthtimeNs).toBe(before.birthtimeNs);
      await expect(result.verify()).resolves.toBeUndefined();
      expect(await readFile(result.executable)).toEqual(fakeBytes);
    }
  );

  it('hashes multiple bounded chunks without interpreting fake executable bytes', async () => {
    const bytes = Buffer.alloc(192 * 1024 + 7, 0x54);
    await writeFile(source, bytes);
    const result = await stageNativeTestNode(source, project);
    expect(result.bytes).toBe(bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(result.executable)).toEqual(bytes);
    await expect(result.verify()).resolves.toBeUndefined();
  });

  it.each(['source', 'copy', 'replace-source', 'replace-copy', 'hardlink-copy'] as const)(
    'refuses %s custody mutation without repairing or deleting failed bytes',
    async (kind) => {
      const result = await stageNativeTestNode(source, project);
      const file = kind.includes('source') ? source : result.executable;
      if (kind.startsWith('replace')) {
        await rename(file, `${file}.old`);
        await writeFile(file, fakeBytes);
      } else if (kind === 'hardlink-copy') await link(file, `${file}.alias`);
      else await writeFile(file, Buffer.from('TEST changed bytes'));
      await expect(result.verify()).rejects.toThrow();
      expect(await readFile(file)).toEqual(
        kind === 'source' || kind === 'copy' ? Buffer.from('TEST changed bytes') : fakeBytes
      );
      expect(await readFile(result.executable)).toEqual(
        kind === 'copy' ? Buffer.from('TEST changed bytes') : fakeBytes
      );
    }
  );

  it.each([
    'symlink-source',
    'symlink-parent',
    'hardlink-source',
    'project-alias',
    'existing-directory',
    'oversize',
    'empty',
    'relative',
    'wrong-name',
    'non-test-project',
  ] as const)('refuses %s', async (kind) => {
    let selected = source,
      destination = project;
    if (kind === 'symlink-source') {
      await rename(source, `${source}.original`);
      await symlink(`${source}.original`, source);
    }
    if (kind === 'symlink-parent') {
      const alias = path.join(root, 'TEST-alias');
      await symlink(path.dirname(source), alias, 'junction');
      selected = path.join(alias, 'node.exe');
    }
    if (kind === 'hardlink-source') await link(source, `${source}.alias`);
    if (kind === 'project-alias') {
      destination = path.join(root, 'TEST-project-alias');
      await symlink(project, destination, 'junction');
    }
    if (kind === 'existing-directory') {
      await mkdir(path.join(project, 'TEST-node-runtime'));
      await writeFile(
        path.join(project, 'TEST-node-runtime', 'node.exe'),
        'TEST retained existing bytes'
      );
    }
    if (kind === 'oversize') await truncate(source, 256 * 1024 * 1024 + 1);
    if (kind === 'empty') await writeFile(source, '');
    if (kind === 'relative') selected = path.relative(process.cwd(), source);
    if (kind === 'wrong-name') {
      selected = path.join(path.dirname(source), 'other.exe');
      await rename(source, selected);
    }
    if (kind === 'non-test-project') {
      destination = path.join(root, 'project');
      await mkdir(destination);
    }
    await expect(stageNativeTestNode(selected, destination)).rejects.toThrow();
    if (kind === 'existing-directory')
      expect(await readFile(path.join(project, 'TEST-node-runtime', 'node.exe'), 'utf8')).toBe(
        'TEST retained existing bytes'
      );
  });
});
