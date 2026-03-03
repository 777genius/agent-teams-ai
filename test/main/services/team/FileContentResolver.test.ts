import { describe, expect, it, vi } from 'vitest';

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
});
