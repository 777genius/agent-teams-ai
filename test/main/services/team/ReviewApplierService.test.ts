import { describe, expect, it, vi } from 'vitest';

import { structuredPatch } from 'diff';

import type { SnippetDiff } from '@shared/types';

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
});
