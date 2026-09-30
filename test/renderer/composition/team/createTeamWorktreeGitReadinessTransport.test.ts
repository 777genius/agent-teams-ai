import { createTeamWorktreeGitReadinessTransport } from '@renderer/composition/team/createTeamWorktreeGitReadinessTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamWorktreeGitStatus } from '@shared/types';

const mocks = vi.hoisted(() => ({
  createInitialGitCommit: vi.fn(),
  getWorktreeGitStatus: vi.fn(),
  initializeGitRepository: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks,
  },
}));

function status(projectPath: string): TeamWorktreeGitStatus {
  return {
    projectPath,
    isGitRepo: true,
    hasHead: true,
    canUseWorktrees: true,
    branch: 'main',
  };
}

describe('createTeamWorktreeGitReadinessTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps provider-neutral readiness capabilities to the legacy team API', async () => {
    const inspected = status('/sandbox/inspect');
    const initialized = status('/sandbox/initialize');
    const committed = status('/sandbox/commit');
    mocks.getWorktreeGitStatus.mockResolvedValueOnce(inspected);
    mocks.initializeGitRepository.mockResolvedValueOnce(initialized);
    mocks.createInitialGitCommit.mockResolvedValueOnce(committed);
    const transport = createTeamWorktreeGitReadinessTransport();

    await expect(transport.getStatus('/sandbox/inspect')).resolves.toBe(inspected);
    await expect(transport.initialize('/sandbox/initialize')).resolves.toBe(initialized);
    await expect(transport.createInitialCommit('/sandbox/commit')).resolves.toBe(committed);

    expect(mocks.getWorktreeGitStatus).toHaveBeenCalledWith('/sandbox/inspect');
    expect(mocks.initializeGitRepository).toHaveBeenCalledWith('/sandbox/initialize');
    expect(mocks.createInitialGitCommit).toHaveBeenCalledWith('/sandbox/commit');
  });

  it('preserves legacy transport failures for the feature hook', async () => {
    const inspectFailure = new Error('inspect failed');
    const initializeFailure = new Error('initialize failed');
    const commitFailure = new Error('commit failed');
    mocks.getWorktreeGitStatus.mockRejectedValueOnce(inspectFailure);
    mocks.initializeGitRepository.mockRejectedValueOnce(initializeFailure);
    mocks.createInitialGitCommit.mockRejectedValueOnce(commitFailure);
    const transport = createTeamWorktreeGitReadinessTransport();

    await expect(transport.getStatus('/sandbox/project')).rejects.toBe(inspectFailure);
    await expect(transport.initialize('/sandbox/project')).rejects.toBe(initializeFailure);
    await expect(transport.createInitialCommit('/sandbox/project')).rejects.toBe(commitFailure);
  });
});
