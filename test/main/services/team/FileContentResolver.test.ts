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

  it('treats empty on-disk content as valid for write-new reconstruction', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as any);

    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath: '/tmp/empty-new.txt',
        toolName: 'Write',
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

  it('reuses cached content only when disk bytes and snippets are unchanged', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue('alpha');

    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const logsFinder = {
      findMemberLogPaths: vi.fn().mockResolvedValue([]),
    };

    const resolver = new FileContentResolver(logsFinder as any);

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

    const resolver = new FileContentResolver(logsFinder as any);

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

    const resolver = new FileContentResolver(logsFinder as any);
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

    const resolver = new FileContentResolver(logsFinder as any);
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

    const resolver = new FileContentResolver(logsFinder as any);

    const missing = await resolver.resolveFileContent('team', 'member', '/tmp/missing-vs-empty.txt', []);
    const empty = await resolver.resolveFileContent('team', 'member', '/tmp/missing-vs-empty.txt', []);

    expect(missing.source).toBe('unavailable');
    expect(empty.source).toBe('disk-current');
    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });

  it('uses the same provisional TTL for all content sources in this pass', async () => {
    const { FileContentResolver } = await import('@main/services/team/FileContentResolver');

    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn() } as any);
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

    const resolver = new FileContentResolver(logsFinder as any);

    await resolver.resolveFileContent('team', 'member', '/tmp/ttl-expiry.txt', []);
    vi.advanceTimersByTime(5_001);
    await resolver.resolveFileContent('team', 'member', '/tmp/ttl-expiry.txt', []);

    expect(logsFinder.findMemberLogPaths).toHaveBeenCalledTimes(2);
  });
});
