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

  it('treats explicit metadata creation as valid for write-new reconstruction', async () => {
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
    expect(content.originalFullContent).toBe('');
    expect(content.modifiedFullContent).toBe('');
    expect(content.contentSource).toBe('snippet-reconstruction');
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
    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(1);
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

  it('reuses cached content only when disk bytes and snippets are unchanged', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('alpha');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);

    await resolver.resolveFileContent('team', 'member', '/tmp/cache-hit.txt', []);
    await resolver.resolveFileContent('team', 'member', '/tmp/cache-hit.txt', []);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(1);
  });

  it('misses cache when disk content changes even if snippets stay the same', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);

    await resolver.resolveFileContent('team', 'member', '/tmp/disk-change.txt', []);
    await resolver.resolveFileContent('team', 'member', '/tmp/disk-change.txt', []);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });

  it('misses cache when snippet fingerprint changes even if disk bytes stay the same', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('alpha');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);
    const firstSnippets: SnippetDiff[] = [];
    const secondSnippets: SnippetDiff[] = [
      {
        toolUseId: 't-edit',
        filePath: '/tmp/snippet-change.txt',
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before',
        newString: 'after',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
    ];

    await resolver.resolveFileContent('team', 'member', '/tmp/snippet-change.txt', firstSnippets);
    await resolver.resolveFileContent('team', 'member', '/tmp/snippet-change.txt', secondSnippets);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });

  it('misses cache when snippet order changes even if snippet content stays the same', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('alpha');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);
    const firstSnippets: SnippetDiff[] = [
      {
        toolUseId: 't-1',
        filePath: '/tmp/snippet-order.txt',
        toolName: 'Edit',
        type: 'edit',
        oldString: 'a',
        newString: 'b',
        replaceAll: false,
        timestamp: '2026-03-01T10:00:00.000Z',
        isError: false,
      },
      {
        toolUseId: 't-2',
        filePath: '/tmp/snippet-order.txt',
        toolName: 'Edit',
        type: 'edit',
        oldString: 'c',
        newString: 'd',
        replaceAll: false,
        timestamp: '2026-03-01T10:01:00.000Z',
        isError: false,
      },
    ];
    const reversedSnippets = [...firstSnippets].reverse();

    await resolver.resolveFileContent('team', 'member', '/tmp/snippet-order.txt', firstSnippets);
    await resolver.resolveFileContent('team', 'member', '/tmp/snippet-order.txt', reversedSnippets);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
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
    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });

  it('uses the same provisional TTL for all content sources in this pass', async () => {
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as never);
    const getCacheTtlForSource = (
      resolver as unknown as {
        getCacheTtlForSource: (source: string) => number;
      }
    ).getCacheTtlForSource.bind(resolver);

    expect(getCacheTtlForSource('file-history')).toBe(5_000);
    expect(getCacheTtlForSource('snippet-reconstruction')).toBe(5_000);
    expect(getCacheTtlForSource('git-fallback')).toBe(5_000);
    expect(getCacheTtlForSource('disk-current')).toBe(5_000);
    expect(getCacheTtlForSource('unavailable')).toBe(5_000);
  });

  it('expires provisional cache entries after the short TTL window', async () => {
    vi.useFakeTimers();

    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('alpha');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as never);

    await resolver.resolveFileContent('team', 'member', '/tmp/ttl-expiry.txt', []);
    vi.advanceTimersByTime(5_001);
    await resolver.resolveFileContent('team', 'member', '/tmp/ttl-expiry.txt', []);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached Windows content across slash and case path variants', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('same content');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };
    const resolver = new FileContentResolver(logsFinder as never);

    await resolver.resolveFileContent('team', 'member', 'C:\\Repo\\SRC\\file.ts', []);
    resolver.invalidateFile('c:/repo/src/file.ts');
    await resolver.resolveFileContent('team', 'member', 'C:\\Repo\\SRC\\file.ts', []);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });
});
