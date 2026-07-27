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
      pendingApprovals: {
        getFileTarget: vi.fn(() => ({
          authorizationGeneration: 'approval-generation-1',
          authorizationPath: REQUEST.filePath,
          readPath: REQUEST.filePath,
        })),
      },
      files,
    });

    await expect(useCase.read(REQUEST)).resolves.toMatchObject({ content: 'approved' });
    expect(files.read).toHaveBeenCalledWith(REQUEST.filePath);
  });

  it('rejects lexical aliases instead of reading an untrusted equivalent path', async () => {
    const files = { read: vi.fn() };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: {
        getFileTarget: vi.fn(() => ({
          authorizationGeneration: 'approval-generation-1',
          authorizationPath: '/workspace/safe/target.txt',
          readPath: '/workspace/safe/target.txt',
        })),
      },
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
      pendingApprovals: { getFileTarget: vi.fn(() => null) },
      files,
    });

    await expect(useCase.read(REQUEST)).resolves.toBeNull();
    expect(files.read).not.toHaveBeenCalled();
  });

  it('preserves relative authorization identity while reading the run-resolved target', async () => {
    const files = {
      read: vi.fn(async () => ({
        content: 'approved',
        exists: true,
        truncated: false,
        isBinary: false,
      })),
    };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: {
        getFileTarget: vi.fn(() => ({
          authorizationGeneration: 'approval-generation-1',
          authorizationPath: 'src/approved.txt',
          readPath: '/workspace/project/src/approved.txt',
        })),
      },
      files,
    });

    await expect(
      useCase.read({
        ...REQUEST,
        filePath: 'src/approved.txt',
      })
    ).resolves.toMatchObject({ content: 'approved' });
    expect(files.read).toHaveBeenCalledWith('/workspace/project/src/approved.txt');
  });

  it('discards content when the approval is revoked during the filesystem read', async () => {
    let active = true;
    const files = {
      read: vi.fn(async () => {
        active = false;
        return {
          content: 'stale content',
          exists: true,
          truncated: false,
          isBinary: false,
        };
      }),
    };
    const useCase = new ReadToolApprovalFilePreview({
      pendingApprovals: {
        getFileTarget: vi.fn(() =>
          active
            ? {
                authorizationGeneration: 'approval-generation-1',
                authorizationPath: REQUEST.filePath,
                readPath: REQUEST.filePath,
              }
            : null
        ),
      },
      files,
    });

    await expect(useCase.read(REQUEST)).resolves.toBeNull();
    expect(files.read).toHaveBeenCalledOnce();
  });
});
