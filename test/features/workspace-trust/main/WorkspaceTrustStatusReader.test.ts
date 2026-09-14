import { WorkspaceTrustStatusReader } from '@features/workspace-trust/main/application/WorkspaceTrustStatusReader';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderStateProbe } from '@features/workspace-trust/core/application';
import type {
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustPathPlatform,
} from '@features/workspace-trust/core/domain';
import type { WorkspaceTrustPathResolution } from '@features/workspace-trust/main/application/WorkspaceTrustStatusReader';

function createReader(input?: {
  enabled?: boolean;
  trustStatus?: 'trusted' | 'untrusted' | 'unknown';
  pathResolution?: WorkspaceTrustPathResolution;
  gitRoot?: string | null;
  featureFlags?: WorkspaceTrustFeatureFlags;
  platform?: WorkspaceTrustPathPlatform;
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
    featureFlags: input?.featureFlags ?? {
      enabled: input?.enabled ?? true,
      claudePty: true,
      codexArgs: true,
      retry: false,
      fileLock: false,
    },
    stateProbe,
    ports: {
      getHomeDir: () => '/home/tester',
      resolvePath,
      resolveGitRoot,
      resolveCanonicalGitRoot: vi.fn().mockResolvedValue('/canonical/repo'),
      platform: input?.platform ?? 'posix',
    },
  });
  return { reader, stateProbe, resolveGitRoot, resolvePath };
}

describe('WorkspaceTrustStatusReader', () => {
  const flags = { enabled: true, claudePty: true, codexArgs: true, retry: false, fileLock: false };
  const request = { projectPath: '/work/repo', providerIds: ['anthropic', 'codex'] as const };
  const readBoth = (reader: WorkspaceTrustStatusReader) =>
    reader.readLaunchStatus({ ...request, providerIds: [...request.providerIds] });

  it('combines persisted Claude and launch-scoped Codex without sharing evidence', async () => {
    const { reader } = createReader({ trustStatus: 'trusted', featureFlags: flags });
    expect(await readBoth(reader)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'trusted' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
  });

  it.each(['claudePty', 'codexArgs'] as const)('keeps %s independent', async (disabled) => {
    const { reader } = createReader({ featureFlags: { ...flags, [disabled]: false } });
    expect(await readBoth(reader)).toEqual({
      providers: [
        { providerId: 'anthropic', status: disabled === 'claudePty' ? 'disabled' : 'untrusted' },
        { providerId: 'codex', status: disabled === 'codexArgs' ? 'disabled' : 'launch_scoped' },
      ],
    });
  });

  it('isolates a Claude failure and deduplicates provider reads', async () => {
    const { reader, stateProbe, resolvePath } = createReader({ featureFlags: flags });
    vi.mocked(stateProbe.readTrustState).mockRejectedValue(new Error('private config details'));
    expect(
      await reader.readLaunchStatus({
        projectPath: request.projectPath,
        providerIds: ['codex', 'anthropic', 'anthropic'],
      })
    ).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'unknown' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
    expect(stateProbe.readTrustState).toHaveBeenCalledTimes(1);
    expect(resolvePath).toHaveBeenCalledTimes(1);
  });

  it.each(['/', '/home/tester'])(
    'does not apply Claude persistence exclusions to Codex: %s',
    async (projectPath) => {
      const { reader } = createReader({
        featureFlags: flags,
        pathResolution: { status: 'resolved', realPath: projectPath },
        gitRoot: null,
      });
      expect(
        await reader.readLaunchStatus({ projectPath, providerIds: [...request.providerIds] })
      ).toEqual({
        providers: [
          { providerId: 'anthropic', status: 'not_applicable' },
          { providerId: 'codex', status: 'launch_scoped' },
        ],
      });
    }
  );

  it('returns unknown if enabled Codex cannot produce applicable settings', async () => {
    const projectPath = '/' + 'x'.repeat(1100);
    const { reader, stateProbe } = createReader({
      featureFlags: flags,
      pathResolution: { status: 'resolved', realPath: projectPath },
      gitRoot: null,
    });
    expect(await reader.readLaunchStatus({ projectPath, providerIds: ['codex'] })).toEqual({
      providers: [{ providerId: 'codex', status: 'unknown' }],
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
  });

  it.each([
    ['/tmp/repo/', '/private/tmp/repo', 'posix', '/tmp/repo'],
    ['/sandbox/проект "a"/', '/sandbox/проект "a"', 'posix', '/sandbox/проект "a"'],
    ['C:\\Work\\Repo\\', 'C:\\work\\repo', 'win32', 'C:/Work/Repo'],
    ['\\\\server\\share\\Repo\\', '\\\\server\\share\\Repo', 'win32', '//server/share/Repo'],
  ] as const)(
    'reuses canonical normalization for %s',
    async (projectPath, realPath, platform, configKeyCwd) => {
      const { reader, stateProbe, resolveGitRoot } = createReader({
        platform,
        pathResolution: { status: 'resolved', realPath },
      });
      await reader.readLaunchStatus({ projectPath, providerIds: ['anthropic', 'codex'] });
      expect(resolveGitRoot).toHaveBeenCalledWith(realPath);
      expect(stateProbe.readTrustState).toHaveBeenCalledWith(
        expect.objectContaining({
          realCwd: realPath,
          configKeyCwd,
          comparisonKey: platform === 'win32' ? configKeyCwd.toLowerCase() : configKeyCwd,
          gitRootConfigKey: '/canonical/repo',
        })
      );
    }
  );

  it('makes git metadata resolution failure common to providers without leaking errors', async () => {
    const { reader, resolveGitRoot, stateProbe } = createReader();
    resolveGitRoot.mockRejectedValue(new Error('private gitdir'));
    expect(await readBoth(reader)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'unknown' },
        { providerId: 'codex', status: 'unknown' },
      ],
    });
    expect(stateProbe.readTrustState).not.toHaveBeenCalled();
  });

  it('does not probe filesystem for all disabled providers or an empty selection', async () => {
    const { reader, resolvePath } = createReader({ featureFlags: { ...flags, enabled: false } });
    expect(await readBoth(reader)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'disabled' },
        { providerId: 'codex', status: 'disabled' },
      ],
    });
    expect(
      await reader.readLaunchStatus({ projectPath: request.projectPath, providerIds: [] })
    ).toEqual({ providers: [] });
    expect(resolvePath).not.toHaveBeenCalled();
  });
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
