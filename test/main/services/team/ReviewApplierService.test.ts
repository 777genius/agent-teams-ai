import { buildReviewChunkContextHashes } from '@shared/utils/reviewChunks';
import { createHash } from 'crypto';
import { structuredPatch } from 'diff';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeWithContent, LedgerChangeRelation, SnippetDiff } from '@shared/types';

const atomicWriteMocks = vi.hoisted(() => ({
  atomicCreateAsync: vi.fn(),
  atomicWriteAsync: vi.fn(),
  cleanupAtomicCreateTempLinks: vi.fn(),
  renamePathWithRetry: vi.fn(),
  unlinkPathDurably: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const unlink = vi.fn();
  const mkdir = vi.fn();
  const lstat = vi.fn();
  const realpath = vi.fn();
  const rename = vi.fn();
  return {
    ...actual,
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    writeFile,
    unlink,
    // ESM interop: some code paths expect a default export
    default: { ...actual, lstat, mkdir, readFile, realpath, rename, writeFile, unlink },
  };
});

vi.mock('@main/utils/atomicWrite', () => atomicWriteMocks);

function regularFileStats(dev = 1, ino = 1) {
  return {
    dev,
    ino,
    mode: 0o100644,
    nlink: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

describe('ReviewApplierService', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const fsPromises = await import('fs/promises');
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    const rename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    lstat.mockResolvedValue(regularFileStats());
    atomicWriteMocks.atomicWriteAsync.mockImplementation(
      async (
        filePath: string,
        content: string,
        options?: { beforeCommit?: () => Promise<void> }
      ) => {
        await options?.beforeCommit?.();
        await writeFile(filePath, content, 'utf8');
      }
    );
    atomicWriteMocks.atomicCreateAsync.mockImplementation(
      async (filePath: string, content: string) => {
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
        const stats = await lstat(filePath);
        return { dev: stats.dev, ino: stats.ino };
      }
    );
    atomicWriteMocks.renamePathWithRetry.mockImplementation(
      async (sourcePath: string, targetPath: string) => rename(sourcePath, targetPath)
    );
    atomicWriteMocks.unlinkPathDurably.mockImplementation(async (filePath: string) =>
      unlink(filePath)
    );
  });

  it('previewReject avoids write-update snippet-level replacement', async () => {
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const original = 'hello\nworld\n';
    const modified = 'HELLO\nworld\n';

    // Sanity: ensure there is at least one hunk for this change
    const patch = structuredPatch('file', 'file', original, modified);
    expect(patch.hunks.length).toBeGreaterThan(0);

    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath: '/tmp/file.txt',
        toolName: 'Write',
        type: 'write-update',
        oldString: '',
        newString: modified, // full file write
        replaceAll: false,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const svc = new ReviewApplierService();

    // Preview should restore original content (and must not collapse to empty due to write-update).
    const preview = await svc.previewReject('/tmp/file.txt', original, modified, [0], snippets);
    expect(preview.hasConflicts).toBe(false);
    expect(preview.preview).toBe(original);
  });

  it('rejects one CodeMirror chunk when jsdiff groups two visual chunks into one hunk', async () => {
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const original = 'a\nmiddle\nb';
    const modified = 'A\nmiddle\nB';

    expect(structuredPatch('file', 'file', original, modified).hunks).toHaveLength(1);

    const first = await svc.previewReject('/tmp/cm-chunks.txt', original, modified, [0], []);
    const second = await svc.previewReject('/tmp/cm-chunks.txt', original, modified, [1], []);

    expect(first).toEqual({ preview: 'a\nmiddle\nB', hasConflicts: false });
    expect(second).toEqual({ preview: 'A\nmiddle\nb', hasConflicts: false });
  });

  it('builds distinct CodeMirror context hashes for repeated nearby changes', () => {
    const original = 'foo\nmiddle\nfoo';
    const modified = 'bar\nmiddle\nbar';

    expect(structuredPatch('file', 'file', original, modified).hunks).toHaveLength(1);
    const hashes = buildReviewChunkContextHashes(original, modified);

    expect(Object.keys(hashes)).toEqual(['0', '1']);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('rejects only the selected visual occurrence from a replaceAll snippet', async () => {
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const original = 'foo\nmiddle\nfoo';
    const modified = 'bar\nmiddle\nbar';
    const snippets: SnippetDiff[] = [
      {
        toolUseId: 'replace-all',
        filePath: '/tmp/replace-all.txt',
        toolName: 'Edit',
        type: 'edit',
        oldString: 'foo',
        newString: 'bar',
        replaceAll: true,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const preview = await svc.previewReject(
      '/tmp/replace-all.txt',
      original,
      modified,
      [0],
      snippets
    );

    expect(preview).toEqual({ preview: 'foo\nmiddle\nbar', hasConflicts: false });
  });

  it('preserves an independent external edit during partial reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/external-edit.txt';
    const original = 'one\ntwo\nthree\nfour\nfive';
    const modified = 'ONE\ntwo\nthree\nfour\nfive';
    const current = 'ONE\ntwo\nUSER\nfour\nfive';
    readFile.mockResolvedValue(current);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const result = await new ReviewApplierService().rejectHunks(
      'team',
      filePath,
      original,
      modified,
      [0],
      []
    );

    expect(result).toEqual({
      success: true,
      newContent: 'one\ntwo\nUSER\nfour\nfive',
      hadConflicts: false,
    });
    expect(writeFile).toHaveBeenCalledWith(filePath, 'one\ntwo\nUSER\nfour\nfive', 'utf8');
  });

  it('blocks partial reject when an external edit overlaps the selected chunk', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('EXTERNAL\ntwo');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const result = await new ReviewApplierService().rejectHunks(
      'team',
      '/tmp/overlap.txt',
      'one\ntwo',
      'ONE\ntwo',
      [0],
      []
    );

    expect(result.success).toBe(false);
    expect(result.hadConflicts).toBe(true);
    expect(result.newContent).toBe('EXTERNAL\ntwo');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('preserves CRLF and trailing blank lines during partial reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/crlf-reject.txt';
    const original = 'one\r\ntwo\r\nthree\r\n\r\n';
    const modified = 'ONE\r\ntwo\r\nTHREE\r\n\r\n';
    readFile.mockResolvedValue(modified);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const result = await new ReviewApplierService().rejectHunks(
      'team',
      filePath,
      original,
      modified,
      [0],
      []
    );

    expect(result).toEqual({
      success: true,
      newContent: 'one\r\ntwo\r\nTHREE\r\n\r\n',
      hadConflicts: false,
    });
    expect(writeFile).toHaveBeenCalledWith(filePath, 'one\r\ntwo\r\nTHREE\r\n\r\n', 'utf8');
  });

  it('serializes concurrent partial rejects for the same file without losing either result', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/concurrent-reject.txt';
    const original = 'a\nmiddle\nb';
    const modified = 'A\nmiddle\nB';
    let diskContent = modified;
    readFile.mockImplementation(async () => diskContent);
    writeFile.mockImplementation(async (_path: string, content: string) => {
      await Promise.resolve();
      diskContent = content;
    });

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const results = await Promise.all([
      svc.rejectHunks('team', filePath, original, modified, [0], []),
      svc.rejectHunks('team', filePath, original, modified, [1], []),
    ]);

    expect(results.every((result) => result.success)).toBe(true);
    expect(diskContent).toBe(original);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('checks guarded saves inside the file lock after a concurrent reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/reject-vs-save.txt';
    const original = 'before\n';
    const modified = 'after\n';
    let diskContent = modified;
    readFile.mockImplementation(async () => diskContent);
    writeFile.mockImplementation(async (_path: string, content: string) => {
      await Promise.resolve();
      diskContent = content;
    });

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const [rejectResult, saveResult] = await Promise.allSettled([
      svc.rejectHunks('team', filePath, original, modified, [0], []),
      svc.saveEditedFile(filePath, 'manual edit\n', modified),
    ]);

    expect(rejectResult).toMatchObject({ status: 'fulfilled', value: { success: true } });
    expect(saveResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'File changed since review update; refusing to overwrite',
      }),
    });
    expect(diskContent).toBe(original);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('creates a missing file exclusively for guarded Undo restoration', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/undo-restored-file.txt';
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    writeFile.mockResolvedValueOnce(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();

    await expect(service.saveEditedFile(filePath, 'restored\n', null)).resolves.toEqual({
      success: true,
    });
    expect(writeFile).toHaveBeenCalledWith(filePath, 'restored\n', {
      encoding: 'utf8',
      flag: 'wx',
    });

    writeFile.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    await expect(service.saveEditedFile(filePath, 'restored\n', null)).rejects.toThrow(
      'refusing to overwrite'
    );
  });

  it('treats an already-published replacement as an idempotent Save retry', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('saved\n');
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().saveEditedFile('/tmp/idempotent-save.txt', 'saved\n', 'before\n')
    ).resolves.toEqual({ success: true });
    expect(atomicWriteMocks.atomicWriteAsync).not.toHaveBeenCalled();
  });

  it('does not claim an independently recreated missing file even when bytes match', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('restored\n');
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().saveEditedFile(
        '/tmp/independent-recreation.txt',
        'restored\n',
        null
      )
    ).rejects.toThrow('refusing to overwrite');
    expect(atomicWriteMocks.atomicCreateAsync).not.toHaveBeenCalled();
  });

  it('uses strict atomic replacement, preserves mode, and repeats the CAS guard', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('before\n');
    lstat.mockResolvedValue({ ...regularFileStats(), mode: 0o100755 });
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await new ReviewApplierService().saveEditedFile(
      '/tmp/executable-save.sh',
      'after\n',
      'before\n'
    );

    expect(atomicWriteMocks.atomicWriteAsync).toHaveBeenCalledWith(
      '/tmp/executable-save.sh',
      'after\n',
      expect.objectContaining({
        mode: 0o755,
        durability: 'strict',
        syncDirectory: true,
        beforeCommit: expect.any(Function),
      })
    );
    expect(lstat).toHaveBeenCalledTimes(2);
  });

  it('refuses atomic replacement when the target inode changes before publish', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('before\n');
    lstat
      .mockResolvedValueOnce(regularFileStats(1, 10))
      .mockResolvedValueOnce(regularFileStats(1, 11));
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().saveEditedFile('/tmp/inode-race.txt', 'after\n', 'before\n')
    ).rejects.toThrow('changed during review update');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('fails closed when reject cannot read the current file', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    const result = await new ReviewApplierService().rejectFile(
      'team',
      '/tmp/unreadable.txt',
      'original\n',
      'modified\n'
    );

    expect(result).toMatchObject({ success: false, hadConflicts: false });
    expect(result.conflictDescription).toContain('Не удалось прочитать файл');
    expect(atomicWriteMocks.atomicWriteAsync).not.toHaveBeenCalled();
  });

  it('makes Undo delete idempotent when the file is already absent', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().deleteEditedFile('/tmp/already-deleted.txt', 'created\n')
    ).resolves.toEqual({ success: true });
    expect(atomicWriteMocks.unlinkPathDurably).not.toHaveBeenCalled();
  });

  it('deletes an Undo-restored file only when its content still matches', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/restored-new-file.ts';
    readFile.mockResolvedValue('restored\n');
    unlink.mockResolvedValue(undefined);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();

    await expect(service.deleteEditedFile(filePath, 'stale\n')).rejects.toThrow(
      'refusing to delete'
    );
    expect(unlink).not.toHaveBeenCalled();
    await expect(service.deleteEditedFile(filePath, 'restored\n')).resolves.toEqual({
      success: true,
    });
    expect(unlink).toHaveBeenCalledWith(filePath);
  });

  it('deletes a newly created file when fully rejected', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('content\n');
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const filePath = '/tmp/new-file.txt';
    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath,
        toolName: 'Write',
        type: 'write-new',
        oldString: '',
        newString: 'content\n',
        replaceAll: false,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'new-file.txt',
            snippets,
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: 'content\n',
            contentSource: 'snippet-reconstruction',
          },
        ],
      ])
    );

    expect(res.applied).toBe(1);
    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('serializes non-ledger new-file deletion with guarded saves', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/locked-new-file.txt';
    const modified = 'created\n';
    let diskContent: string | null = modified;
    let releaseWrite = (): void => undefined;
    let signalWriteStarted = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    readFile.mockImplementation(async () => {
      if (diskContent === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return diskContent;
    });
    writeFile.mockImplementation(async (_path: string, content: string) => {
      signalWriteStarted();
      await writeGate;
      diskContent = content;
    });
    unlink.mockImplementation(async () => {
      diskContent = null;
    });

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();
    const save = service.saveEditedFile(filePath, 'manual\n', modified);
    await writeStarted;
    const reject = service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([[filePath, buildNewFileChange(filePath, modified, false)]])
    );
    releaseWrite();

    await expect(save).resolves.toEqual({ success: true });
    await expect(reject).resolves.toMatchObject({ applied: 0, conflicts: 1 });
    expect(diskContent).toBe('manual\n');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('serializes ledger new-file deletion with guarded saves', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/locked-ledger-new-file.txt';
    const modified = 'created\n';
    let diskContent: string | null = modified;
    let releaseWrite = (): void => undefined;
    let signalWriteStarted = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    readFile.mockImplementation(async () => {
      if (diskContent === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return diskContent;
    });
    writeFile.mockImplementation(async (_path: string, content: string) => {
      signalWriteStarted();
      await writeGate;
      diskContent = content;
    });
    unlink.mockImplementation(async () => {
      diskContent = null;
    });

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();
    const save = service.saveEditedFile(filePath, 'manual\n', modified);
    await writeStarted;
    const reject = service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([[filePath, buildNewFileChange(filePath, modified, true)]])
    );
    releaseWrite();

    await expect(save).resolves.toEqual({ success: true });
    await expect(reject).resolves.toMatchObject({ applied: 0, conflicts: 1 });
    expect(diskContent).toBe('manual\n');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger create reject deletes only when current hash matches', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const content = 'created\n';
    readFile.mockResolvedValue(content);
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/ledger-created.txt';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'ledger-created.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: content,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: content,
                  beforeHash: null,
                  afterHash: sha(content),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(content), sizeBytes: content.length },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: content,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(unlink).toHaveBeenCalledWith(filePath);
  });

  it('ledger create reject blocks metadata-only create even when final hash is known', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/metadata-only-created.txt';
    const content = 'created\n';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'metadata-only-created.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Edit',
                type: 'edit',
                oldString: '',
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'medium',
                  originalFullContent: null,
                  modifiedFullContent: null,
                  beforeHash: null,
                  afterHash: sha(content),
                  operation: 'create',
                  beforeState: {
                    exists: false,
                    unavailableReason: 'gitless-before-content-unavailable',
                  },
                  afterState: { exists: true, sha256: sha(content), sizeBytes: content.length },
                },
              },
            ],
            linesAdded: 0,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: null,
            modifiedFullContent: null,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.errors[0]?.code).toBe('manual-review-required');
    expect(readFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger create reject blocks when current hash changed', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('user changed\n');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/ledger-conflict.txt';
    const ledgerContent = 'created\n';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'ledger-conflict.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: ledgerContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: ledgerContent,
                  beforeHash: null,
                  afterHash: sha(ledgerContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(ledgerContent) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: ledgerContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(1);
    expect(res.errors[0]?.code).toBe('conflict');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger delete reject restores exclusively and fails closed on a recreation race', async () => {
    const fsPromises = await import('fs/promises');
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/deleted.txt';
    const original = 'restore me\n';
    const changes: Map<string, FileChangeWithContent> = new Map([
      [
        filePath,
        {
          filePath,
          relativePath: 'deleted.txt',
          snippets: [
            {
              toolUseId: 'ledger-1',
              filePath,
              toolName: 'Bash',
              type: 'shell-snapshot',
              oldString: original,
              newString: '',
              replaceAll: false,
              timestamp: '2026-03-01T10:00:00.000Z',
              isError: false,
              ledger: {
                eventId: 'event-1',
                source: 'ledger-snapshot',
                confidence: 'high',
                originalFullContent: original,
                modifiedFullContent: null,
                beforeHash: sha(original),
                afterHash: null,
                operation: 'delete',
                beforeState: { exists: true, sha256: sha(original) },
                afterState: { exists: false },
              },
            },
          ],
          linesAdded: 0,
          linesRemoved: 1,
          isNewFile: false,
          originalFullContent: original,
          modifiedFullContent: '',
          contentSource: 'ledger-snapshot',
        },
      ],
    ]);
    const request = {
      teamName: 'team',
      decisions: [
        { filePath, fileDecision: 'rejected' as const, hunkDecisions: { 0: 'rejected' as const } },
      ],
    };

    const res = await svc.applyReviewDecisions(request, changes);

    expect(res.applied).toBe(1);
    expect(mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(filePath, original, {
      encoding: 'utf8',
      flag: 'wx',
    });

    writeFile.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    const raced = await svc.applyReviewDecisions(request, changes);

    expect(raced.applied).toBe(0);
    expect(raced.conflicts).toBe(1);
    expect(raced.errors[0]?.code).toBe('conflict');
  });

  it('ledger binary or large unavailable content requires manual review', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('binary placeholder');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/blob.bin';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'blob.bin',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: null,
                  beforeHash: null,
                  afterHash: null,
                  operation: 'modify',
                  beforeState: { exists: true, unavailableReason: 'binary file' },
                  afterState: { exists: true, unavailableReason: 'binary file' },
                },
              },
            ],
            linesAdded: 0,
            linesRemoved: 0,
            isNewFile: false,
            originalFullContent: null,
            modifiedFullContent: null,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.errors[0]?.code).toBe('manual-review-required');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('ledger rename reject restores old path and deletes new path with hash guards', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;

    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === newPath) return newContent;
      if (filePath === oldPath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw new Error(`unexpected read ${filePath}`);
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src/new.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: oldPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: oldContent,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-old',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: oldContent,
                  modifiedFullContent: null,
                  beforeHash: sha(oldContent),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(oldContent) },
                  afterState: { exists: false },
                  relation,
                },
              },
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(mkdir).toHaveBeenCalledWith('/repo/src', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(oldPath, oldContent, {
      encoding: 'utf8',
      flag: 'wx',
    });
    expect(unlink).toHaveBeenCalledWith(newPath);
  });

  it('replays a crash-left ledger rename reject idempotently after it already reached disk', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === oldPath) return oldContent;
      if (filePath === newPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      throw new Error(`unexpected read ${filePath}`);
    });
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    const result = await new ReviewApplierService().applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([[newPath, change]])
    );

    expect(result).toEqual({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('refuses to resurrect the old rename path when both paths disappeared externally', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().reapplyRejectedRename(newPath, oldContent, change.snippets)
    ).rejects.toThrow('Renamed target path is missing');
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('removes a newly restored old path if the rename target changes before deletion', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    const files = new Map([[newPath, newContent]]);
    let newPathReads = 0;
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === newPath && ++newPathReads === 2) {
        files.set(newPath, 'external\n');
      }
      const content = files.get(filePath);
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockImplementation(async (filePath: string, content: string, options: unknown) => {
      if (
        typeof options === 'object' &&
        options !== null &&
        'flag' in options &&
        options.flag === 'wx' &&
        files.has(filePath)
      ) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      files.set(filePath, content);
    });
    unlink.mockImplementation(async (filePath: string) => {
      if (!files.delete(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().reapplyRejectedRename(newPath, oldContent, change.snippets)
    ).rejects.toThrow('Renamed target changed during reject');
    expect(files.has(oldPath)).toBe(false);
    expect(files.get(newPath)).toBe('external\n');
    expect(unlink).toHaveBeenCalledWith(oldPath);
    expect(unlink).not.toHaveBeenCalledWith(newPath);
  });

  it('undoes a rejected ledger rename by restoring the target and removing the old path', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    const files = new Map([[oldPath, oldContent]]);
    readFile.mockImplementation(async (filePath: string) => {
      const content = files.get(filePath);
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockImplementation(async (filePath: string, content: string, options: unknown) => {
      if (
        typeof options === 'object' &&
        options !== null &&
        'flag' in options &&
        options.flag === 'wx' &&
        files.has(filePath)
      ) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      files.set(filePath, content);
    });
    unlink.mockImplementation(async (filePath: string) => {
      if (!files.delete(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();

    await expect(
      service.restoreRejectedRename(newPath, oldContent, newContent, change.snippets)
    ).resolves.toEqual({ success: true });
    expect(files.get(newPath)).toBe(newContent);
    expect(files.has(oldPath)).toBe(false);
    expect(writeFile).toHaveBeenCalledWith(newPath, newContent, {
      encoding: 'utf8',
      flag: 'wx',
    });
    expect(unlink).toHaveBeenCalledWith(oldPath);

    await expect(
      service.reapplyRejectedRename(newPath, oldContent, change.snippets)
    ).resolves.toEqual({ success: true });
    expect(files.get(oldPath)).toBe(oldContent);
    expect(files.has(newPath)).toBe(false);
  });

  it('refuses rename Undo when the restored old path changed externally', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === oldPath) return 'external edit\n';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().restoreRejectedRename(
        newPath,
        oldContent,
        newContent,
        change.snippets
      )
    ).rejects.toThrow('Original rename path changed after rejection');
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger case-only rename reject restores the aliased file without unlinking it', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    const realpath = fsPromises.realpath as unknown as ReturnType<typeof vi.fn>;
    const rename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/Foo.ts';
    const newPath = '/repo/src/foo.ts';
    const oldContent = 'export const value = 1;\n';
    const newContent = 'export const value = 2;\n';
    readFile.mockResolvedValue(newContent);
    lstat.mockResolvedValue(regularFileStats(42, 777));
    realpath.mockResolvedValue(newPath);
    rename.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const relation = { kind: 'rename' as const, oldPath: 'src/Foo.ts', newPath: 'src/foo.ts' };
    const result = await new ReviewApplierService().applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src/foo.ts',
            snippets: [
              {
                toolUseId: 'ledger-case-rename',
                filePath: oldPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: oldContent,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'case-old',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: oldContent,
                  modifiedFullContent: null,
                  beforeHash: sha(oldContent),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(oldContent) },
                  afterState: { exists: false },
                  relation,
                },
              },
              {
                toolUseId: 'ledger-case-rename',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'case-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(result).toMatchObject({ applied: 1, conflicts: 0, errors: [] });
    expect(rename).toHaveBeenCalledWith(newPath, oldPath);
    expect(writeFile).toHaveBeenCalledWith(oldPath, oldContent, 'utf8');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('rolls a case-only rename back if restoring the old content fails', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    const rename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/Foo.ts';
    const newPath = '/repo/src/foo.ts';
    const oldContent = 'export const value = 1;\n';
    const newContent = 'export const value = 2;\n';
    readFile.mockResolvedValue(newContent);
    lstat.mockResolvedValue(regularFileStats(42, 777));
    rename.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    const relation = { kind: 'rename' as const, oldPath: 'src/Foo.ts', newPath: 'src/foo.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().reapplyRejectedRename(newPath, oldContent, change.snippets)
    ).rejects.toThrow('Failed to reject case-only ledger rename');
    expect(rename).toHaveBeenNthCalledWith(1, newPath, oldPath);
    expect(rename).toHaveBeenNthCalledWith(2, oldPath, newPath);
    expect(writeFile).not.toHaveBeenCalledWith(newPath, newContent, 'utf8');
  });

  it('undoes a rejected case-only ledger rename without creating a second file', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
    const rename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const oldPath = '/repo/src/Foo.ts';
    const newPath = '/repo/src/foo.ts';
    const oldContent = 'export const value = 1;\n';
    const newContent = 'export const value = 2;\n';
    readFile.mockResolvedValue(oldContent);
    lstat.mockResolvedValue(regularFileStats(42, 777));
    rename.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    const relation = { kind: 'rename' as const, oldPath: 'src/Foo.ts', newPath: 'src/foo.ts' };
    const change = buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');

    await expect(
      new ReviewApplierService().restoreRejectedRename(
        newPath,
        oldContent,
        newContent,
        change.snippets
      )
    ).resolves.toEqual({ success: true });
    expect(rename).toHaveBeenCalledWith(oldPath, newPath);
    expect(writeFile).toHaveBeenCalledWith(newPath, newContent, 'utf8');
    expect(unlink).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'darwin')(
    'ledger canonical-equivalent rename keeps the sole inode on a real temporary filesystem',
    async () => {
      const actualFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const fsPromises = await import('fs/promises');
      const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
      const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
      const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
      const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;
      const lstat = fsPromises.lstat as unknown as ReturnType<typeof vi.fn>;
      const rename = fsPromises.rename as unknown as ReturnType<typeof vi.fn>;
      readFile.mockImplementation(actualFs.readFile);
      writeFile.mockImplementation(actualFs.writeFile);
      unlink.mockImplementation(actualFs.unlink);
      mkdir.mockImplementation(actualFs.mkdir);
      lstat.mockImplementation(actualFs.lstat);
      rename.mockImplementation(actualFs.rename);

      const tempDirectory = await actualFs.mkdtemp(join(tmpdir(), 'changes-unicode-rename-'));
      const oldPath = join(tempDirectory, '\u00e9.ts');
      const newPath = join(tempDirectory, 'e\u0301.ts');
      const oldContent = 'export const value = 1;\n';
      const newContent = 'export const value = 2;\n';

      try {
        await actualFs.writeFile(newPath, newContent, 'utf8');
        const relation = {
          kind: 'rename' as const,
          oldPath: '\u00e9.ts',
          newPath: 'e\u0301.ts',
        };
        const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
        const result = await new ReviewApplierService().applyReviewDecisions(
          {
            teamName: 'team',
            decisions: [
              { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
            ],
          },
          new Map([
            [newPath, buildLedgerRenameChange(oldPath, newPath, oldContent, newContent, relation)],
          ])
        );

        expect(result).toEqual({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
        expect(await actualFs.readFile(oldPath, 'utf8')).toBe(oldContent);
        expect(await actualFs.readdir(tempDirectory)).toHaveLength(1);
        expect(unlink).not.toHaveBeenCalled();
      } finally {
        await actualFs.rm(tempDirectory, { recursive: true, force: true });
      }
    }
  );

  it('ledger rename reject blocks when new path hash changed', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockResolvedValue('user changed\n');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src/new.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: oldPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: oldContent,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-old',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: oldContent,
                  modifiedFullContent: null,
                  beforeHash: sha(oldContent),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(oldContent) },
                  afterState: { exists: false },
                  relation,
                },
              },
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(1);
    expect(res.errors[0]?.code).toBe('conflict');
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger rename reject resolves Windows relation paths case-insensitively', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;

    const newPath = 'C:\\Repo\\SRC\\New.ts';
    const expectedOldPath = 'C:/Repo/src/OLD.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === newPath) return newContent;
      if (filePath === expectedOldPath)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw new Error(`unexpected read ${filePath}`);
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const relation = { kind: 'rename' as const, oldPath: 'src/OLD.ts', newPath: 'src/NEW.ts' };

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'SRC\\New.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(mkdir).toHaveBeenCalledWith('C:/Repo/src', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(expectedOldPath, oldContent, {
      encoding: 'utf8',
      flag: 'wx',
    });
    expect(unlink).toHaveBeenCalledWith(newPath);
  });

  it('ledger rename reject does not infer related paths from unsafe suffix matches', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const newPath = 'C:\\Repo\\src\\renew.ts';
    const newContent = 'new\n';
    const relation = { kind: 'rename' as const, oldPath: 'old.ts', newPath: 'new.ts' };

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src\\renew.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: 'old\n',
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.errors[0]?.code).toBe('manual-review-required');
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('treats delete-then-create on an existing ledger file as modify, not new-file delete', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const filePath = '/tmp/replaced.ts';
    const original = 'export const value = 1;\n';
    const modified = 'export const value = 2;\n';
    readFile.mockResolvedValue(modified);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected', 1: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'replaced.ts',
            snippets: [
              {
                toolUseId: 'ledger-delete',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: original,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-delete',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: original,
                  modifiedFullContent: null,
                  beforeHash: sha(original),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: false },
                },
              },
              {
                toolUseId: 'ledger-create',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: modified,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-create',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: modified,
                  beforeHash: null,
                  afterHash: sha(modified),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(modified) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(writeFile).toHaveBeenCalledWith(filePath, original, 'utf8');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger full modify reject accepts legacy afterHash when afterState hash is absent', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    const filePath = '/tmp/legacy-ledger.ts';
    const original = 'export const value = 1;\n';
    const modified = 'export const value = 2;\n';
    readFile.mockResolvedValue(modified);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'legacy-ledger.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Edit',
                type: 'edit',
                oldString: original,
                newString: modified,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-exact',
                  confidence: 'exact',
                  originalFullContent: original,
                  modifiedFullContent: modified,
                  beforeHash: sha(original),
                  afterHash: sha(modified),
                  operation: 'modify',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: true },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-exact',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(writeFile).toHaveBeenCalledWith(filePath, original, 'utf8');
  });

  it('ledger exact partial reject stays in the strict ledger lane and applies inverse hunk patch', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    const filePath = '/tmp/exact-ledger.ts';
    const original = 'const value = 1;\nconst keep = true;\n';
    const modified = 'const value = 2;\nconst keep = true;\n';
    readFile.mockResolvedValue(modified);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'rejected', 1: 'pending' },
            hunkContextHashes: buildHunkContextHashes(original, modified),
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'exact-ledger.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Edit',
                type: 'edit',
                oldString: 'const value = 1;\n',
                newString: 'const value = 2;\n',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-exact',
                  confidence: 'exact',
                  originalFullContent: original,
                  modifiedFullContent: modified,
                  beforeHash: sha(original),
                  afterHash: sha(modified),
                  operation: 'modify',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: true, sha256: sha(modified) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-exact',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(writeFile).toHaveBeenCalledWith(filePath, original, 'utf8');
  });

  it('applies two sequential ledger chunk rejects while preserving the first reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/sequential-ledger.ts';
    const original = 'one\nmiddle-a\nmiddle-b\nmiddle-c\nthree\n';
    const modified = 'ONE\nmiddle-a\nmiddle-b\nmiddle-c\nTHREE\n';
    let diskContent = modified;
    readFile.mockImplementation(async () => diskContent);
    writeFile.mockImplementation(async (_path: string, content: string) => {
      diskContent = content;
    });

    const hashes = buildHunkContextHashes(original, modified);
    expect(Object.keys(hashes)).toEqual(['0', '1']);
    const fileContents = new Map([
      [filePath, buildLedgerModifyChange(filePath, original, modified)],
    ]);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();

    const first = await service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'rejected', 1: 'pending' },
            hunkContextHashes: hashes,
          },
        ],
      },
      fileContents
    );
    const second = await service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'pending', 1: 'rejected' },
            hunkContextHashes: hashes,
          },
        ],
      },
      fileContents
    );

    expect(first).toEqual({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
    expect(second).toEqual({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
    expect(diskContent).toBe(original);
  });

  it('preserves a prior ledger reject and a non-overlapping external edit on the next reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/sequential-ledger-external.ts';
    const original = 'one\nmiddle-a\nmiddle-b\nmiddle-c\nthree\ntail-a\ntail-b\ntail-c\ntail-d\n';
    const modified = 'ONE\nmiddle-a\nmiddle-b\nmiddle-c\nTHREE\ntail-a\ntail-b\ntail-c\ntail-d\n';
    let diskContent = modified;
    readFile.mockImplementation(async () => diskContent);
    writeFile.mockImplementation(async (_path: string, content: string) => {
      diskContent = content;
    });

    const hashes = buildHunkContextHashes(original, modified);
    const fileContents = new Map([
      [filePath, buildLedgerModifyChange(filePath, original, modified)],
    ]);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const service = new ReviewApplierService();
    await service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'rejected', 1: 'pending' },
            hunkContextHashes: hashes,
          },
        ],
      },
      fileContents
    );
    diskContent = diskContent.replace('tail-d', 'external-tail-d');

    const second = await service.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'pending', 1: 'rejected' },
            hunkContextHashes: hashes,
          },
        ],
      },
      fileContents
    );

    expect(second).toEqual({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
    expect(diskContent).toBe(
      'one\nmiddle-a\nmiddle-b\nmiddle-c\nthree\ntail-a\ntail-b\ntail-c\nexternal-tail-d\n'
    );
  });

  it('fails closed when a current edit overlaps the next ledger reject', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const filePath = '/tmp/overlap-ledger.ts';
    const original = 'one\nmiddle-a\nmiddle-b\nmiddle-c\nthree\n';
    const modified = 'ONE\nmiddle-a\nmiddle-b\nmiddle-c\nTHREE\n';
    let diskContent = 'ONE\nmiddle-a\nmiddle-b\nmiddle-c\nEXTERNAL\n';
    readFile.mockImplementation(async () => diskContent);
    writeFile.mockImplementation(async (_path: string, content: string) => {
      diskContent = content;
    });

    const hashes = buildHunkContextHashes(original, modified);
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const result = await new ReviewApplierService().applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'pending', 1: 'rejected' },
            hunkContextHashes: hashes,
          },
        ],
      },
      new Map([[filePath, buildLedgerModifyChange(filePath, original, modified)]])
    );

    expect(result.applied).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.errors[0]?.code).toBe('conflict');
    expect(diskContent).toContain('EXTERNAL');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('ledger partial reject refuses stale hunk context instead of falling back to index', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    const filePath = '/tmp/stale-ledger.ts';
    const original = 'const value = 1;\nconst keep = true;\n';
    const modified = 'const value = 2;\nconst keep = true;\n';
    readFile.mockResolvedValue(modified);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'rejected', 1: 'pending' },
            hunkContextHashes: { 0: 'stale-context-hash' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'stale-ledger.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Edit',
                type: 'edit',
                oldString: 'const value = 1;\n',
                newString: 'const value = 2;\n',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-exact',
                  confidence: 'exact',
                  originalFullContent: original,
                  modifiedFullContent: modified,
                  beforeHash: sha(original),
                  afterHash: sha(modified),
                  operation: 'modify',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: true, sha256: sha(modified) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-exact',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(1);
    expect(res.errors[0]?.code).toBe('conflict');
    expect(writeFile).not.toHaveBeenCalled();
  });
});

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildHunkContextHashes(original: string, modified: string): Record<number, string> {
  return buildReviewChunkContextHashes(original, modified);
}

function buildLedgerRenameChange(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
  relation: LedgerChangeRelation
): FileChangeWithContent {
  return {
    filePath: newPath,
    relativePath: relation.newPath,
    snippets: [
      {
        toolUseId: 'ledger-unicode-rename',
        filePath: oldPath,
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: oldContent,
        newString: '',
        replaceAll: false,
        timestamp: '2026-07-16T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'unicode-old',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: oldContent,
          modifiedFullContent: null,
          beforeHash: sha(oldContent),
          afterHash: null,
          operation: 'delete',
          beforeState: { exists: true, sha256: sha(oldContent) },
          afterState: { exists: false },
          relation,
        },
      },
      {
        toolUseId: 'ledger-unicode-rename',
        filePath: newPath,
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: '',
        newString: newContent,
        replaceAll: false,
        timestamp: '2026-07-16T10:00:01.000Z',
        isError: false,
        ledger: {
          eventId: 'unicode-new',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: null,
          modifiedFullContent: newContent,
          beforeHash: null,
          afterHash: sha(newContent),
          operation: 'create',
          beforeState: { exists: false },
          afterState: { exists: true, sha256: sha(newContent) },
          relation,
        },
      },
    ],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    originalFullContent: oldContent,
    modifiedFullContent: newContent,
    contentSource: 'ledger-snapshot',
  };
}

function buildLedgerModifyChange(
  filePath: string,
  original: string,
  modified: string
): FileChangeWithContent {
  return {
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    snippets: [
      {
        toolUseId: 'ledger-sequential',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: original,
        newString: modified,
        replaceAll: false,
        timestamp: '2026-07-16T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'sequential-modify',
          source: 'ledger-exact',
          confidence: 'exact',
          originalFullContent: original,
          modifiedFullContent: modified,
          beforeHash: sha(original),
          afterHash: sha(modified),
          operation: 'modify',
          beforeState: { exists: true, sha256: sha(original) },
          afterState: { exists: true, sha256: sha(modified) },
        },
      },
    ],
    linesAdded: 2,
    linesRemoved: 2,
    isNewFile: false,
    originalFullContent: original,
    modifiedFullContent: modified,
    contentSource: 'ledger-exact',
  };
}

function buildNewFileChange(
  filePath: string,
  modified: string,
  ledger: boolean
): FileChangeWithContent {
  const snippet: SnippetDiff = {
    toolUseId: ledger ? 'ledger-create-lock' : 'write-new-lock',
    filePath,
    toolName: ledger ? 'Bash' : 'Write',
    type: ledger ? 'shell-snapshot' : 'write-new',
    oldString: '',
    newString: modified,
    replaceAll: false,
    timestamp: '2026-07-16T10:00:00.000Z',
    isError: false,
    ...(ledger
      ? {
          ledger: {
            eventId: 'locked-create',
            source: 'ledger-snapshot' as const,
            confidence: 'high' as const,
            originalFullContent: null,
            modifiedFullContent: modified,
            beforeHash: null,
            afterHash: sha(modified),
            operation: 'create' as const,
            beforeState: { exists: false },
            afterState: { exists: true, sha256: sha(modified) },
          },
        }
      : {}),
  };
  return {
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    snippets: [snippet],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: true,
    originalFullContent: '',
    modifiedFullContent: modified,
    contentSource: ledger ? 'ledger-snapshot' : 'snippet-reconstruction',
  };
}
