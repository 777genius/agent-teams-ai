import { describe, expect, it, vi } from 'vitest';

import { structuredPatch } from 'diff';

import type { SnippetDiff } from '@shared/types';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const unlink = vi.fn();
  return {
    ...actual,
    readFile,
    writeFile,
    unlink,
    // ESM interop: some code paths expect a default export
    default: { ...actual, readFile, writeFile, unlink },
  };
});

describe('ReviewApplierService', () => {
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
});
