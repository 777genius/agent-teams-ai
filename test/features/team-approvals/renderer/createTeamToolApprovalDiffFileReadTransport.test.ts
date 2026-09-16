import { createTeamToolApprovalDiffFileReadTransport } from '@renderer/composition/team/createTeamToolApprovalDiffFileReadTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolApprovalFileReadRequest } from '@features/team-approvals/contracts';

const mocks = vi.hoisted(() => ({
  readFileForToolApproval: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      readFileForToolApproval: mocks.readFileForToolApproval,
    },
  },
}));

const request: ToolApprovalFileReadRequest = {
  teamName: 'sandbox-team',
  runId: 'run-1',
  requestId: 'approval-1',
  filePath: '/sandbox/project/src/file.ts',
};

describe('createTeamToolApprovalDiffFileReadTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the approval-scoped file read without changing its request or result', async () => {
    const result = {
      content: 'before',
      exists: true,
      truncated: false,
      isBinary: false,
    };
    mocks.readFileForToolApproval.mockResolvedValueOnce(result);

    await expect(createTeamToolApprovalDiffFileReadTransport().readFile(request)).resolves.toBe(
      result
    );
    expect(mocks.readFileForToolApproval).toHaveBeenCalledWith(request);
  });

  it('preserves read failures for the diff hook error policy', async () => {
    const failure = new Error('approval file unavailable');
    mocks.readFileForToolApproval.mockRejectedValueOnce(failure);

    await expect(createTeamToolApprovalDiffFileReadTransport().readFile(request)).rejects.toBe(
      failure
    );
  });
});
