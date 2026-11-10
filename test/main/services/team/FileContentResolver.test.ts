import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnippetDiff } from '@shared/types';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const access = vi.fn();
  const readFile = vi.fn();
  return {
    ...actual,
    access,
    readFile,
    // ESM interop: some code paths expect a default export
    default: { ...actual, access, readFile },
  };
});

describe('FileContentResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('does not trust metadata-only creation without a captured postimage', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);

    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath: '/tmp/empty-new.txt',
        toolName: 'Edit',
        type: 'write-new',
        oldString: '',
        newString: '',
        replaceAll: false,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const content = await resolver.getFileContent('team', 'member', '/tmp/empty-new.txt', snippets);
    expect(content.isNewFile).toBe(true);
    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('');
    expect(content.contentSource).toBe('disk-current');
  });

  it('shows a captured creation through an IPC-normalized dot path without trusting its baseline', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('created\n');
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/new.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'native-add',
        filePath: '/tmp/./new.txt',
        toolName: 'Edit',
        type: 'write-new',
        oldString: '',
        newString: 'created\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content).toMatchObject({
      originalFullContent: null,
      modifiedFullContent: 'created\n',
      contentSource: 'disk-current',
    });
  });

  it('keeps a native add preview only when a symlink and parent segment can alias another path', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('created\n');
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);
    const filePath = '/tmp/test-review/new.txt';

    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'native-add-through-alias',
        filePath: '/tmp/test-review/link/../new.txt',
        toolName: 'Edit',
        type: 'write-new',
        oldString: '',
        newString: 'created\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content).toMatchObject({
      originalFullContent: null,
      modifiedFullContent: 'created\n',
      contentSource: 'disk-current',
    });
    expect(readFile).toHaveBeenCalledWith(filePath, 'utf8');
  });

  it('does not trust a stale first-seen Write label as creation evidence', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('replacement\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };
    const resolver = new FileContentResolver(logsFinder as never);
    const filePath = '/tmp/legacy-first-write.txt';
    const snippets: SnippetDiff[] = [
      {
        toolUseId: 'legacy-write',
        filePath,
        toolName: 'Write',
        type: 'write-new',
        oldString: '',
        newString: 'replacement\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ];

    const content = await resolver.getFileContent('team', 'member', filePath, snippets);

    expect(content.isNewFile).toBe(false);
    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('replacement\n');
    expect(content.contentSource).toBe('disk-current');
  });

  it('does not invent a baseline when an edit postimage occurs more than once', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('after\nafter\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/repeated-postimage.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'edit-repeated',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before\n',
        newString: 'after\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('after\nafter\n');
    expect(content.contentSource).toBe('disk-current');
  });

  it('does not reverse a replace-all without knowing which postimages predated the edit', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('after\nafter\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/replace-all-ambiguous.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'replace-all-ambiguous',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before\n',
        newString: 'after\n',
        replaceAll: true,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('after\nafter\n');
    expect(content.contentSource).toBe('disk-current');
  });

  it('does not use a committed Git version as the task baseline after ambiguous replacement', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('after\nuser note\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const gitFallback = {
      isGitRepo: vi.fn().mockResolvedValue(true),
      findCommitNearTimestamp: vi.fn().mockResolvedValue('commit-before-task'),
      getFileAtCommit: vi.fn().mockResolvedValue('before\ncommitted note\n'),
    };
    const resolver = new FileContentResolver(
      { findMemberLogPaths: vi.fn().mockResolvedValue([]) } as never,
      gitFallback as never
    );
    const filePath = '/tmp/task-replace-all.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'replace-all',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before\n',
        newString: 'after\n',
        replaceAll: true,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content.originalFullContent).toBeNull();
    expect(content.contentSource).toBe('disk-current');
    expect(gitFallback.getFileAtCommit).not.toHaveBeenCalled();
  });

  it('keeps a metadata-only edit baseline unavailable instead of treating it as a no-op', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('modified\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/metadata-only-edit.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'metadata-only',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: '',
        newString: '',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('modified\n');
    expect(content.contentSource).toBe('disk-current');
  });

  it('does not delete a pre-existing path that was deleted and recreated during the task', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('replacement\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/delete-then-recreate.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'delete-original',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'original\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
      {
        toolUseId: 'recreate',
        filePath,
        toolName: 'Edit',
        type: 'write-new',
        oldString: '',
        newString: 'replacement\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:01:00.000Z',
        isError: false,
      },
    ]);

    expect(content.isNewFile).toBe(false);
    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBe('replacement\n');
    expect(content.contentSource).toBe('disk-current');
  });

  it('does not infer creation from a tied timestamp with conflicting lifecycle events', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('replacement\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/tied-lifecycle.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'a-recreate',
        filePath,
        toolName: 'Edit',
        type: 'write-new',
        oldString: '',
        newString: 'replacement\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
      {
        toolUseId: 'z-delete',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'original\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ]);

    expect(content).toMatchObject({
      isNewFile: false,
      originalFullContent: null,
      modifiedFullContent: 'replacement\n',
    });
  });

  it('sanitizes stale aggregate isNewFile state without creation evidence', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('replacement\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);
    const filePath = '/tmp/stale-summary-write.txt';
    const snippets: SnippetDiff[] = [
      {
        toolUseId: 'legacy-write',
        filePath,
        toolName: 'Write',
        type: 'write-new',
        oldString: '',
        newString: 'replacement\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ];

    const contents = await resolver.resolveAllFileContents('team', 'member', [
      {
        filePath,
        relativePath: 'stale-summary-write.txt',
        snippets,
        linesAdded: 1,
        linesRemoved: 0,
        isNewFile: true,
      },
    ]);

    expect(contents.get(filePath)?.isNewFile).toBe(false);
    expect(contents.get(filePath)?.originalFullContent).toBeNull();
  });

  it('maps ledger create original content to empty string without disk reconstruction', async () => {
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);

    const content = await resolver.getFileContent('team', 'member', '/tmp/ledger-create.txt', [
      {
        toolUseId: 'ledger-1',
        filePath: '/tmp/ledger-create.txt',
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: '',
        newString: 'created\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'event-1',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: null,
          modifiedFullContent: 'created\n',
          beforeHash: null,
          afterHash: 'hash',
          operation: 'create',
          beforeState: { exists: false },
          afterState: { exists: true, sha256: 'hash' },
        },
      },
    ]);

    expect(content.originalFullContent).toBe('');
    expect(content.modifiedFullContent).toBe('created\n');
    expect(content.contentSource).toBe('ledger-snapshot');
  });

  it('maps ledger delete modified content to empty string for diff display', async () => {
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);

    const content = await resolver.getFileContent('team', 'member', '/tmp/ledger-delete.txt', [
      {
        toolUseId: 'ledger-1',
        filePath: '/tmp/ledger-delete.txt',
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: 'deleted\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'event-1',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: 'deleted\n',
          modifiedFullContent: null,
          beforeHash: 'hash',
          afterHash: null,
          operation: 'delete',
          beforeState: { exists: true, sha256: 'hash' },
          afterState: { exists: false },
        },
      },
    ]);

    expect(content.originalFullContent).toBe('deleted\n');
    expect(content.modifiedFullContent).toBe('');
    expect(content.contentSource).toBe('ledger-snapshot');
  });

  it('treats delete-existing then recreate-same-path as a modification', async () => {
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);
    const filePath = '/tmp/recreated.txt';
    const content = await resolver.getFileContent('team', 'member', filePath, [
      {
        toolUseId: 'delete-1',
        filePath,
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: 'old\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'event-delete',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: 'old\n',
          modifiedFullContent: null,
          beforeHash: 'old-hash',
          afterHash: null,
          operation: 'delete',
          beforeState: { exists: true, sha256: 'old-hash' },
          afterState: { exists: false },
        },
      },
      {
        toolUseId: 'create-2',
        filePath,
        toolName: 'Bash',
        type: 'shell-snapshot',
        oldString: '',
        newString: 'new\n',
        replaceAll: false,
        timestamp: '2026-03-01T10:01:00.000Z',
        isError: false,
        ledger: {
          eventId: 'event-create',
          source: 'ledger-snapshot',
          confidence: 'high',
          originalFullContent: null,
          modifiedFullContent: 'new\n',
          beforeHash: null,
          afterHash: 'new-hash',
          operation: 'create',
          beforeState: { exists: false },
          afterState: { exists: true, sha256: 'new-hash' },
        },
      },
    ]);

    expect(content).toMatchObject({
      isNewFile: false,
      originalFullContent: 'old\n',
      modifiedFullContent: 'new\n',
    });
  });

  it('does not synthesize empty text for metadata-only ledger lifecycle states', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('current disk content that must not become ledger text');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    } as never);

    const content = await resolver.getFileContent('team', 'member', '/tmp/binary-create.bin', [
      {
        toolUseId: 'ledger-1',
        filePath: '/tmp/binary-create.bin',
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
          afterHash: 'hash',
          operation: 'create',
          beforeState: { exists: false, unavailableReason: 'binary file' },
          afterState: { exists: true, sha256: 'hash', unavailableReason: 'binary file' },
        },
      },
    ]);

    expect(content.originalFullContent).toBeNull();
    expect(content.modifiedFullContent).toBeNull();
    expect(content.contentSource).toBe('unavailable');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('distinguishes missing-file fingerprints from empty-file fingerprints', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);

    const missing = await resolver.resolveFileContent(
      'team',
      'member',
      '/tmp/missing-vs-empty.txt',
      []
    );
    const empty = await resolver.resolveFileContent(
      'team',
      'member',
      '/tmp/missing-vs-empty.txt',
      []
    );

    expect(missing.source).toBe('unavailable');
    expect(empty.source).toBe('disk-current');
  });

  it('refreshes a cached preview when current disk content changes', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValueOnce('created\n').mockResolvedValueOnce('updated\n');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);
    const snippet: SnippetDiff = {
      toolUseId: 'add-1',
      filePath: '/tmp/cache-creation.txt',
      toolName: 'Edit',
      type: 'write-new',
      oldString: '',
      newString: 'created\n',
      replaceAll: false,
      timestamp: '2026-03-01T10:00:00.000Z',
      isError: false,
    };

    const captured = await resolver.resolveFileContent('team', 'member', snippet.filePath, [
      snippet,
    ]);
    const updated = await resolver.resolveFileContent('team', 'member', snippet.filePath, [
      snippet,
    ]);

    expect(captured).toEqual({ original: null, modified: 'created\n', source: 'disk-current' });
    expect(updated).toEqual({ original: null, modified: 'updated\n', source: 'disk-current' });
  });
});
