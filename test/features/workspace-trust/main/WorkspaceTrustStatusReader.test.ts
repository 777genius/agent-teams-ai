import { WorkspaceTrustStatusReader } from '@features/workspace-trust/main/application/WorkspaceTrustStatusReader';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderStateProbe } from '@features/workspace-trust/core/application';
import type { WorkspaceTrustPathResolution } from '@features/workspace-trust/main/application/WorkspaceTrustStatusReader';

function createReader(input?: {
  enabled?: boolean;
  trustStatus?: 'trusted' | 'untrusted' | 'unknown';
  pathResolution?: WorkspaceTrustPathResolution;
  gitRoot?: string | null;
}) {
  const stateProbe: ProviderStateProbe = {
    readTrustState: vi.fn().mockResolvedValue({
      status: input?.trustStatus ?? 'untrusted',
    }),
  };
  const resolvePath = vi
    .fn()
    .mockResolvedValue(input?.pathResolution ?? { status: 'resolved', realPath: '/work/repo' });
  const resolveGitRoot = vi
    .fn()
    .mockResolvedValue(input && 'gitRoot' in input ? input.gitRoot : '/work/repo');
  const reader = new WorkspaceTrustStatusReader({
    enabled: input?.enabled ?? true,
    stateProbe,
    ports: {
      getHomeDir: () => '/home/tester',
      resolvePath,
      resolveGitRoot,
      resolveCanonicalGitRoot: vi.fn().mockResolvedValue('/canonical/repo'),
      platform: 'posix',
    },
  });
  return { reader, stateProbe, resolveGitRoot };
}

describe('WorkspaceTrustStatusReader', () => {
  it('returns the current Claude trust state for a persistable project', async () => {
    const { reader, stateProbe } = createReader({ trustStatus: 'untrusted' });

    await expect(reader.read({ projectPath: '/work/repo/app' })).resolves.toEqual({
      status: 'untrusted',
    });
    expect(stateProbe.readTrustState).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo/app',
        realCwd: '/work/repo',
        gitRootConfigKey: '/canonical/repo',
        persistable: true,
      })
    );
  });

  it('does not inspect provider state when workspace trust automation is disabled', async () => {
    const { reader, stateProbe } = createReader({ enabled: false });

    await expect(reader.read({ projectPath: '/work/repo' })).resolves.toEqual({
      status: 'disabled',
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
  });

  it('does not show a trust warning for a project directory that does not exist yet', async () => {
    const { reader, stateProbe, resolveGitRoot } = createReader({
      pathResolution: { status: 'missing' },
    });

    await expect(reader.read({ projectPath: '/missing/repo' })).resolves.toEqual({
      status: 'not_applicable',
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
    expect(resolveGitRoot).not.toHaveBeenCalled();
  });

  it('returns unknown when the selected path cannot be inspected safely', async () => {
    const { reader, stateProbe, resolveGitRoot } = createReader({
      pathResolution: { status: 'unknown' },
    });

    await expect(reader.read({ projectPath: '/restricted/repo' })).resolves.toEqual({
      status: 'unknown',
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
    expect(resolveGitRoot).not.toHaveBeenCalled();
  });

  it('does not claim that a protected home-directory target will be trusted', async () => {
    const { reader, stateProbe } = createReader({
      pathResolution: { status: 'resolved', realPath: '/home/tester' },
      gitRoot: null,
    });

    await expect(reader.read({ projectPath: '/home/tester' })).resolves.toEqual({
      status: 'not_applicable',
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
  });
});
