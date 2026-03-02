/**
 * Tests for ProjectFileService — path security, binary detection, size limits.
 */

import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs/promises before importing the service
vi.mock('fs/promises', () => ({
  lstat: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  cp: vi.fn(),
  copyFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('@main/utils/atomicWrite', () => ({
  atomicWriteAsync: vi.fn(),
}));

vi.mock('isbinaryfile', () => ({
  isBinaryFile: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: {
    trashItem: vi.fn(),
  },
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { shell } from 'electron';
import * as fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';

import { atomicWriteAsync } from '../../../../src/main/utils/atomicWrite';
import { ProjectFileService } from '../../../../src/main/services/editor/ProjectFileService';

// =============================================================================
// Setup
// =============================================================================

const PROJECT_ROOT = path.resolve('/Users/test/my-project');
let service: ProjectFileService;

const mockLstat = vi.mocked(fs.lstat);
const mockStat = vi.mocked(fs.stat);
const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);
const mockRealpath = vi.mocked(fs.realpath);
const mockIsBinary = vi.mocked(isBinaryFile);
const mockRename = vi.mocked(fs.rename);
const mockCp = vi.mocked(fs.cp);
const mockRm = vi.mocked(fs.rm);

function createStats(
  overrides: Partial<Record<string, unknown>> = {}
): Awaited<ReturnType<typeof fs.lstat>> {
  return {
    isFile: () => overrides.isFile ?? true,
    isDirectory: () => overrides.isDirectory ?? false,
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    size: overrides.size ?? 1024,
    mtimeMs: overrides.mtimeMs ?? Date.now(),
  } as Awaited<ReturnType<typeof fs.lstat>>;
}

function createDirent(
  name: string,
  type: 'file' | 'directory' | 'symlink'
): {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
} {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  service = new ProjectFileService();
});

// =============================================================================
// readDir
// =============================================================================

describe('ProjectFileService.readDir', () => {
  it('returns sorted directory listing (dirs first, then alpha)', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('zebra.ts', 'file'),
      createDirent('src', 'directory'),
      createDirent('alpha.ts', 'file'),
      createDirent('docs', 'directory'),
    ] as never);
    mockStat.mockResolvedValue(createStats({ size: 512 }));

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT);

    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(['docs', 'src', 'alpha.ts', 'zebra.ts']);
    expect(result.entries[0].type).toBe('directory');
    expect(result.entries[2].type).toBe('file');
  });

  it('filters out ignored directories (node_modules, .git, etc.)', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('node_modules', 'directory'),
      createDirent('.git', 'directory'),
      createDirent('src', 'directory'),
      createDirent('.next', 'directory'),
    ] as never);

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('src');
  });

  it('filters out ignored files (.DS_Store, Thumbs.db)', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('.DS_Store', 'file'),
      createDirent('Thumbs.db', 'file'),
      createDirent('index.ts', 'file'),
    ] as never);
    mockStat.mockResolvedValue(createStats({ size: 100 }));

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('index.ts');
  });

  it('marks sensitive files with isSensitive flag', async () => {
    const projectWithEnv = PROJECT_ROOT;
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('.env', 'file'),
      createDirent('.env.local', 'file'),
      createDirent('index.ts', 'file'),
    ] as never);
    mockStat.mockResolvedValue(createStats({ size: 100 }));

    const result = await service.readDir(projectWithEnv, projectWithEnv);

    const envEntry = result.entries.find((e) => e.name === '.env');
    const envLocalEntry = result.entries.find((e) => e.name === '.env.local');
    const indexEntry = result.entries.find((e) => e.name === 'index.ts');

    expect(envEntry?.isSensitive).toBe(true);
    expect(envLocalEntry?.isSensitive).toBe(true);
    expect(indexEntry?.isSensitive).toBeUndefined();
  });

  it('rejects paths outside project root (SEC-1)', async () => {
    await expect(service.readDir(PROJECT_ROOT, '/etc/passwd')).rejects.toThrow(
      'Directory is outside project root'
    );
  });

  it('rejects path traversal via ../ (SEC-1)', async () => {
    const traversalPath = path.join(PROJECT_ROOT, '..', '..', 'etc');
    await expect(service.readDir(PROJECT_ROOT, traversalPath)).rejects.toThrow(
      'Directory is outside project root'
    );
  });

  it('rejects non-directory paths', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: false, isFile: true }));

    await expect(service.readDir(PROJECT_ROOT, PROJECT_ROOT + '/file.txt')).rejects.toThrow(
      'Not a directory'
    );
  });

  it('truncates at maxEntries', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    const dirents = Array.from({ length: 10 }, (_, i) => createDirent(`file${i}.ts`, 'file'));
    mockReaddir.mockResolvedValue(dirents as never);
    mockStat.mockResolvedValue(createStats({ size: 100 }));

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT, 3);

    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('silently skips symlinks that escape project root (SEC-2)', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('safe-link', 'symlink'),
      createDirent('escape-link', 'symlink'),
      createDirent('normal.ts', 'file'),
    ] as never);

    mockRealpath.mockImplementation(async (p) => {
      const name = path.basename(String(p));
      if (name === 'safe-link') return path.join(PROJECT_ROOT, 'actual-dir');
      return '/etc/shadow'; // escapes project
    });

    mockStat.mockResolvedValue(createStats({ size: 100, isDirectory: true, isFile: false }));

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT);

    const names = result.entries.map((e) => e.name);
    expect(names).toContain('safe-link');
    expect(names).toContain('normal.ts');
    expect(names).not.toContain('escape-link');
  });

  it('silently skips broken symlinks', async () => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockReaddir.mockResolvedValue([
      createDirent('broken-link', 'symlink'),
      createDirent('normal.ts', 'file'),
    ] as never);

    mockRealpath.mockRejectedValue(new Error('ENOENT'));
    mockStat.mockResolvedValue(createStats({ size: 100 }));

    const result = await service.readDir(PROJECT_ROOT, PROJECT_ROOT);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('normal.ts');
  });
});

// =============================================================================
// readFile
// =============================================================================

describe('ProjectFileService.readFile', () => {
  it('returns file content with metadata', async () => {
    const filePath = PROJECT_ROOT + '/src/index.ts';
    const content = 'export const hello = "world";';
    const now = Date.now();

    mockLstat.mockResolvedValue(createStats({ size: content.length, mtimeMs: now }));
    mockIsBinary.mockResolvedValue(false);
    mockReadFile.mockResolvedValue(content);
    mockRealpath.mockResolvedValue(filePath);

    const result = await service.readFile(PROJECT_ROOT, filePath);

    expect(result.content).toBe(content);
    expect(result.size).toBe(content.length);
    expect(result.mtimeMs).toBe(now);
    expect(result.isBinary).toBe(false);
    expect(result.encoding).toBe('utf-8');
    expect(result.truncated).toBe(false);
  });

  it('returns binary indicator for binary files', async () => {
    const filePath = PROJECT_ROOT + '/image.png';

    mockLstat.mockResolvedValue(createStats({ size: 4096, mtimeMs: Date.now() }));
    mockIsBinary.mockResolvedValue(true);

    const result = await service.readFile(PROJECT_ROOT, filePath);

    expect(result.isBinary).toBe(true);
    expect(result.content).toBe('');
    expect(result.encoding).toBe('binary');
  });

  it('rejects files larger than 5MB preview limit', async () => {
    const filePath = PROJECT_ROOT + '/huge.log';
    const hugeSize = 6 * 1024 * 1024;

    mockLstat.mockResolvedValue(createStats({ size: hugeSize }));

    await expect(service.readFile(PROJECT_ROOT, filePath)).rejects.toThrow('File too large');
  });

  it('returns preview (100 lines) for files between 2-5MB', async () => {
    const filePath = PROJECT_ROOT + '/large.json';
    const fileSize = 3 * 1024 * 1024;
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const fullContent = lines.join('\n');

    mockLstat.mockResolvedValue(createStats({ size: fileSize, mtimeMs: Date.now() }));
    mockIsBinary.mockResolvedValue(false);
    mockReadFile.mockResolvedValue(fullContent);
    mockRealpath.mockResolvedValue(filePath);

    const result = await service.readFile(PROJECT_ROOT, filePath);

    expect(result.truncated).toBe(true);
    expect(result.content.split('\n')).toHaveLength(100);
  });

  it('rejects sensitive file paths (.env, .ssh)', async () => {
    const envPath = PROJECT_ROOT + '/.env';
    await expect(service.readFile(PROJECT_ROOT, envPath)).rejects.toThrow(
      'Access to sensitive files is not allowed'
    );
  });

  it('rejects paths outside project root', async () => {
    await expect(service.readFile(PROJECT_ROOT, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects device paths (SEC-4)', async () => {
    const devPath = '/dev/zero';
    // /dev/zero is outside project root, so it should throw before device check
    await expect(service.readFile(PROJECT_ROOT, devPath)).rejects.toThrow();
  });

  it('rejects non-regular files (directories, etc.)', async () => {
    const dirPath = PROJECT_ROOT + '/src';
    mockLstat.mockResolvedValue(createStats({ isFile: false, isDirectory: true }));

    await expect(service.readFile(PROJECT_ROOT, dirPath)).rejects.toThrow('Not a regular file');
  });

  it('detects TOCTOU — rejects if path changed during read (SEC-3)', async () => {
    const filePath = PROJECT_ROOT + '/safe.ts';

    mockLstat.mockResolvedValue(createStats({ size: 100, mtimeMs: Date.now() }));
    mockIsBinary.mockResolvedValue(false);
    mockReadFile.mockResolvedValue('content');
    // realpath returns a path OUTSIDE project root (symlink swapped)
    mockRealpath.mockResolvedValue('/etc/shadow');

    await expect(service.readFile(PROJECT_ROOT, filePath)).rejects.toThrow(
      'Path changed during read (TOCTOU)'
    );
  });
});

// =============================================================================
// writeFile
// =============================================================================

const mockAtomicWrite = vi.mocked(atomicWriteAsync);

describe('ProjectFileService.writeFile', () => {
  const CONTENT = 'export const hello = "world";';

  beforeEach(() => {
    mockAtomicWrite.mockResolvedValue(undefined);
    mockStat.mockResolvedValue(createStats({ size: CONTENT.length, mtimeMs: Date.now() }));
  });

  it('writes file via atomic write and returns stats', async () => {
    const filePath = PROJECT_ROOT + '/src/index.ts';
    const now = Date.now();
    mockStat.mockResolvedValue(createStats({ size: 28, mtimeMs: now }));

    const result = await service.writeFile(PROJECT_ROOT, filePath, CONTENT);

    expect(mockAtomicWrite).toHaveBeenCalledWith(path.resolve(filePath), CONTENT);
    expect(result.size).toBe(28);
    expect(result.mtimeMs).toBe(now);
  });

  it('rejects paths outside project root (SEC-14)', async () => {
    await expect(service.writeFile(PROJECT_ROOT, '/etc/passwd', 'malicious')).rejects.toThrow();
  });

  it('rejects path traversal via ../ (SEC-1)', async () => {
    const traversalPath = path.join(PROJECT_ROOT, '..', '..', 'etc', 'passwd');
    await expect(service.writeFile(PROJECT_ROOT, traversalPath, 'malicious')).rejects.toThrow();
  });

  it('rejects .git/ internal paths (SEC-12)', async () => {
    const gitPath = PROJECT_ROOT + '/.git/config';
    await expect(service.writeFile(PROJECT_ROOT, gitPath, 'malicious')).rejects.toThrow(
      'Cannot write to .git/ directory'
    );
  });

  it('rejects sensitive file paths (.env)', async () => {
    const envPath = PROJECT_ROOT + '/.env';
    await expect(service.writeFile(PROJECT_ROOT, envPath, 'SECRET=key')).rejects.toThrow();
  });

  it('rejects content larger than 2MB', async () => {
    const filePath = PROJECT_ROOT + '/src/large.ts';
    const largeContent = 'a'.repeat(3 * 1024 * 1024);

    await expect(service.writeFile(PROJECT_ROOT, filePath, largeContent)).rejects.toThrow(
      'Content too large'
    );
  });

  it('rejects device paths (SEC-4)', async () => {
    const devPath = '/dev/null';
    await expect(service.writeFile(PROJECT_ROOT, devPath, 'data')).rejects.toThrow();
  });

  it('passes through atomic write errors', async () => {
    const filePath = PROJECT_ROOT + '/src/index.ts';
    mockAtomicWrite.mockRejectedValue(new Error('Disk full'));

    await expect(service.writeFile(PROJECT_ROOT, filePath, CONTENT)).rejects.toThrow('Disk full');
  });
});

// =============================================================================
// createFile
// =============================================================================

const mockWriteFile = vi.mocked(fs.writeFile);
const mockAccess = vi.mocked(fs.access);
const mockMkdir = vi.mocked(fs.mkdir);
const mockTrashItem = vi.mocked(shell.trashItem);

describe('ProjectFileService.createFile', () => {
  beforeEach(() => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockWriteFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue(createStats({ size: 0, mtimeMs: 1234567890 }));
  });

  it('creates an empty file and returns stats', async () => {
    const parentDir = PROJECT_ROOT + '/src';
    const result = await service.createFile(PROJECT_ROOT, parentDir, 'new-file.ts');

    expect(result.filePath).toBe(path.join(PROJECT_ROOT, 'src', 'new-file.ts'));
    expect(result.mtimeMs).toBe(1234567890);
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(PROJECT_ROOT, 'src', 'new-file.ts'),
      '',
      'utf8'
    );
  });

  it('rejects invalid file name (empty)', async () => {
    await expect(service.createFile(PROJECT_ROOT, PROJECT_ROOT, '')).rejects.toThrow(
      'Name is required'
    );
  });

  it('rejects invalid file name (..)', async () => {
    await expect(service.createFile(PROJECT_ROOT, PROJECT_ROOT, '..')).rejects.toThrow(
      'Invalid name'
    );
  });

  it('rejects paths outside project root', async () => {
    await expect(service.createFile(PROJECT_ROOT, '/etc', 'file.ts')).rejects.toThrow();
  });

  it('rejects if file already exists', async () => {
    mockAccess.mockResolvedValue(undefined); // File exists

    await expect(
      service.createFile(PROJECT_ROOT, PROJECT_ROOT + '/src', 'existing.ts')
    ).rejects.toThrow('File already exists');
  });

  it('blocks .git/ internal paths (SEC-12)', async () => {
    await expect(
      service.createFile(PROJECT_ROOT, PROJECT_ROOT + '/.git', 'config')
    ).rejects.toThrow();
  });
});

// =============================================================================
// createDir
// =============================================================================

describe('ProjectFileService.createDir', () => {
  beforeEach(() => {
    mockLstat.mockResolvedValue(createStats({ isDirectory: true, isFile: false }));
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockMkdir.mockResolvedValue(undefined);
  });

  it('creates a directory', async () => {
    const parentDir = PROJECT_ROOT + '/src';
    const result = await service.createDir(PROJECT_ROOT, parentDir, 'new-dir');

    expect(result.dirPath).toBe(path.join(PROJECT_ROOT, 'src', 'new-dir'));
    expect(mockMkdir).toHaveBeenCalledWith(path.join(PROJECT_ROOT, 'src', 'new-dir'));
  });

  it('rejects invalid dir name', async () => {
    await expect(service.createDir(PROJECT_ROOT, PROJECT_ROOT, '..')).rejects.toThrow(
      'Invalid name'
    );
  });

  it('rejects paths outside project root', async () => {
    await expect(service.createDir(PROJECT_ROOT, '/tmp', 'dir')).rejects.toThrow();
  });

  it('rejects if directory already exists', async () => {
    mockAccess.mockResolvedValue(undefined);

    await expect(
      service.createDir(PROJECT_ROOT, PROJECT_ROOT + '/src', 'existing-dir')
    ).rejects.toThrow('Directory already exists');
  });
});

// =============================================================================
// deleteFile
// =============================================================================

describe('ProjectFileService.deleteFile', () => {
  beforeEach(() => {
    mockLstat.mockResolvedValue(createStats({ isFile: true }));
    mockTrashItem.mockResolvedValue(undefined);
  });

  it('moves file to trash', async () => {
    const filePath = PROJECT_ROOT + '/src/old-file.ts';
    const result = await service.deleteFile(PROJECT_ROOT, filePath);

    expect(result.deletedPath).toBe(path.resolve(filePath));
    expect(mockTrashItem).toHaveBeenCalledWith(path.resolve(filePath));
  });

  it('rejects paths outside project root', async () => {
    await expect(service.deleteFile(PROJECT_ROOT, '/etc/passwd')).rejects.toThrow();
  });

  it('blocks .git/ internal paths (SEC-12)', async () => {
    await expect(service.deleteFile(PROJECT_ROOT, PROJECT_ROOT + '/.git/config')).rejects.toThrow(
      'Cannot delete files in .git/ directory'
    );
  });

  it('rejects sensitive file paths', async () => {
    await expect(service.deleteFile(PROJECT_ROOT, PROJECT_ROOT + '/.env')).rejects.toThrow();
  });
});

// =============================================================================
// moveFile
// =============================================================================

describe('ProjectFileService.moveFile', () => {
  const SRC_DIR = path.join(PROJECT_ROOT, 'src');
  const DEST_DIR = path.join(PROJECT_ROOT, 'lib');

  beforeEach(() => {
    mockRename.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('moves a file to a new directory (happy path)', async () => {
    const sourcePath = SRC_DIR + '/index.ts';
    mockLstat
      .mockResolvedValueOnce(createStats({ isFile: true })) // source exists
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })); // dest is dir

    const result = await service.moveFile(PROJECT_ROOT, sourcePath, DEST_DIR);

    expect(result.newPath).toBe(path.join(DEST_DIR, 'index.ts'));
    expect(result.isDirectory).toBe(false);
    expect(mockRename).toHaveBeenCalledWith(
      path.resolve(sourcePath),
      path.join(DEST_DIR, 'index.ts')
    );
  });

  it('moves a directory to a new directory (happy path)', async () => {
    const sourceDir = PROJECT_ROOT + '/utils';
    mockLstat
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })) // source
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })); // dest

    const result = await service.moveFile(PROJECT_ROOT, sourceDir, DEST_DIR);

    expect(result.newPath).toBe(path.join(DEST_DIR, 'utils'));
    expect(result.isDirectory).toBe(true);
    expect(mockRename).toHaveBeenCalled();
  });

  it('rejects parent → child move', async () => {
    const sourceDir = SRC_DIR;
    const childDir = SRC_DIR + '/nested';
    mockLstat
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false }))
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false }));

    await expect(service.moveFile(PROJECT_ROOT, sourceDir, childDir)).rejects.toThrow(
      'Cannot move a directory into itself'
    );
  });

  it('rejects when destination file already exists', async () => {
    const sourcePath = SRC_DIR + '/index.ts';
    mockLstat
      .mockResolvedValueOnce(createStats({ isFile: true }))
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false }));
    mockAccess.mockResolvedValue(undefined); // file exists at dest

    await expect(service.moveFile(PROJECT_ROOT, sourcePath, DEST_DIR)).rejects.toThrow(
      'File already exists at destination'
    );
  });

  it('rejects .git/ source paths (SEC-12)', async () => {
    const gitPath = PROJECT_ROOT + '/.git/hooks';

    await expect(service.moveFile(PROJECT_ROOT, gitPath, DEST_DIR)).rejects.toThrow(
      'Cannot move files from .git/ directory'
    );
  });

  it('rejects .git/ destination paths (SEC-12)', async () => {
    const sourcePath = SRC_DIR + '/index.ts';
    const gitDest = PROJECT_ROOT + '/.git';

    await expect(service.moveFile(PROJECT_ROOT, sourcePath, gitDest)).rejects.toThrow(
      'Cannot move files into .git/ directory'
    );
  });

  it('rejects paths outside project root', async () => {
    await expect(service.moveFile(PROJECT_ROOT, '/etc/passwd', DEST_DIR)).rejects.toThrow();
    await expect(service.moveFile(PROJECT_ROOT, SRC_DIR + '/index.ts', '/tmp')).rejects.toThrow();
  });

  it('falls back to cp+rm on EXDEV error (cross-device)', async () => {
    const sourcePath = SRC_DIR + '/index.ts';
    mockLstat
      .mockResolvedValueOnce(createStats({ isFile: true })) // source exists
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })) // dest is dir
      .mockResolvedValueOnce(createStats({ isFile: true })); // EXDEV fallback stat

    const exdevError = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    mockRename.mockRejectedValueOnce(exdevError);

    const mockCopyFile = vi.mocked(fs.copyFile);
    mockCopyFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const result = await service.moveFile(PROJECT_ROOT, sourcePath, DEST_DIR);

    expect(result.newPath).toBe(path.join(DEST_DIR, 'index.ts'));
    expect(mockCopyFile).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalled();
  });

  it('falls back to cp+rm for directories on EXDEV error', async () => {
    const sourceDir = PROJECT_ROOT + '/utils';
    mockLstat
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })) // source
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })) // dest
      .mockResolvedValueOnce(createStats({ isDirectory: true, isFile: false })); // EXDEV fallback

    const exdevError = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    mockRename.mockRejectedValueOnce(exdevError);
    mockCp.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const result = await service.moveFile(PROJECT_ROOT, sourceDir, DEST_DIR);

    expect(result.newPath).toBe(path.join(DEST_DIR, 'utils'));
    expect(mockCp).toHaveBeenCalledWith(path.resolve(sourceDir), path.join(DEST_DIR, 'utils'), {
      recursive: true,
    });
    expect(mockRm).toHaveBeenCalledWith(path.resolve(sourceDir), {
      recursive: true,
      force: true,
    });
  });
});
