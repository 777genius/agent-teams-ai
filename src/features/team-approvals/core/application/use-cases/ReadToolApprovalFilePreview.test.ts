import { describe, expect, it, vi } from 'vitest';

import { ReadToolApprovalFilePreview } from './ReadToolApprovalFilePreview';

const REQUEST = {
  teamName: 'team-one',
  runId: 'run-1',
  requestId: 'request-1',
  filePath: '/workspace/approved.txt',
};

describe('ReadToolApprovalFilePreview', () => {
  it('reads the exact path returned by the active approval capability', async () => {
    const files = {
      read: vi.fn(async () => ({
        content: 'approved',
        exists: true,
        truncated: false,
        isBinary: false,
      })),
    };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: { getFilePath: vi.fn(() => REQUEST.filePath) },
      files,
    });

    await expect(useCase.read(REQUEST)).resolves.toMatchObject({ content: 'approved' });
    expect(files.read).toHaveBeenCalledWith(REQUEST.filePath);
  });

  it('rejects lexical aliases instead of reading an untrusted equivalent path', async () => {
    const files = { read: vi.fn() };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: { getFilePath: vi.fn(() => '/workspace/safe/target.txt') },
      files,
    });

    await expect(
      useCase.read({
        ...REQUEST,
        filePath: '/workspace/pivot/../safe/target.txt',
      })
    ).resolves.toBeNull();
    expect(files.read).not.toHaveBeenCalled();
  });

  it('rejects missing or stale approval identities before filesystem access', async () => {
    const files = { read: vi.fn() };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: { getFilePath: vi.fn(() => null) },
      files,
    });

    await expect(useCase.read(REQUEST)).resolves.toBeNull();
    expect(files.read).not.toHaveBeenCalled();
  });
});
