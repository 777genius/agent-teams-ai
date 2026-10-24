import { describe, expect, it, vi } from 'vitest';

import { deduplicateEditorRead } from '../../src/renderer/utils/editorReadRequest';

import type { ReadFileResult } from '../../src/shared/types/editor';

describe('editor rejected read cleanup', () => {
  it('deduplicates a rejected IPC read and cleans up without an unhandled rejection', async () => {
    const pending = new Map<string, Promise<ReadFileResult>>();
    const read = vi.fn(() => Promise.reject(new Error('missing file')));
    const first = deduplicateEditorRead(pending, 'missing', read);
    const second = deduplicateEditorRead(pending, 'missing', read);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow('missing file');
    // Vitest records any derived unhandled rejection. The former finally(cleanup)
    // fails this test even though the original promise rejection is awaited above.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(deduplicateEditorRead(pending, 'missing', read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
