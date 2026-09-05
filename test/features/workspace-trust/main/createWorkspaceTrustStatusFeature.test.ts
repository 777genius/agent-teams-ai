import fs from 'node:fs/promises';

import { createWorkspaceTrustStatusFeature } from '@features/workspace-trust/main/composition/createWorkspaceTrustStatusFeature';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LaunchTrustRequest } from '@features/workspace-trust/contracts';

vi.mock('node:fs/promises', () => ({
  default: { realpath: vi.fn(), stat: vi.fn(), readFile: vi.fn() },
}));
vi.mock('@features/workspace-trust/main/infrastructure/WorkspaceTrustCanonicalGitRoot', () => ({
  resolveWorkspaceTrustFilesystemGitRoot: vi.fn(async () => null),
  resolveWorkspaceTrustCanonicalGitRoot: vi.fn(async (root: string) => root),
}));

const request: LaunchTrustRequest = {
  projectPath: '/sandbox/repo',
  providerIds: ['anthropic', 'codex'],
};
const config = {
  getHomeDir: () => '/sandbox/home',
  globalConfigFilePath: '/sandbox/claude.json',
  env: {},
};
const unknown = {
  providers: [
    { providerId: 'anthropic', status: 'unknown' },
    { providerId: 'codex', status: 'unknown' },
  ],
};

describe('workspace trust guarded facade', () => {
  beforeEach(() => {
    vi.mocked(fs.realpath).mockResolvedValue('/sandbox/repo');
    vi.mocked(fs.stat).mockResolvedValue({ size: 100, isDirectory: () => true } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ projects: { '/sandbox/repo': { hasTrustDialogAccepted: true } } })
    );
  });
  afterEach(() => vi.resetAllMocks());

  it.each([
    null,
    [],
    42,
    {},
    { ...request, projectPath: '' },
    { ...request, projectPath: 'relative' },
    { ...request, projectPath: '/x\0y' },
    { ...request, projectPath: '/' + 'a'.repeat(4096) },
    { ...request, providerIds: ['gemini'] },
    { ...request, providerIds: Array(33).fill('codex') },
    { ...request, providerIds: 'codex' },
  ])('rejects malformed input without filesystem probing: %j', async (value) => {
    const feature = createWorkspaceTrustStatusFeature(config);
    expect(await feature.getLaunchStatus(value as LaunchTrustRequest)).toEqual(unknown);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('blocks local probing for remote context including legacy API and dynamic callbacks', async () => {
    const getHomeDir = vi.fn(config.getHomeDir);
    const globalConfigFilePath = vi.fn(() => config.globalConfigFilePath);
    const feature = createWorkspaceTrustStatusFeature({
      ...config,
      getHomeDir,
      globalConfigFilePath,
      isLocalContext: () => false,
    });
    expect(await feature.getLaunchStatus(request)).toEqual(unknown);
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'unknown' });
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(getHomeDir).not.toHaveBeenCalled();
    expect(globalConfigFilePath).not.toHaveBeenCalled();
  });

  it('keeps flags, selected config and host callbacks fresh between requests', async () => {
    const env: NodeJS.ProcessEnv = {};
    let local = false;
    let configPath = '/sandbox/one.json';
    const feature = createWorkspaceTrustStatusFeature({
      ...config,
      env,
      isLocalContext: () => local,
      globalConfigFilePath: () => configPath,
    });
    expect(await feature.getLaunchStatus(request)).toEqual(unknown);
    local = true;
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'trusted' });
    expect(fs.readFile).toHaveBeenLastCalledWith('/sandbox/one.json', 'utf8');
    configPath = '/sandbox/two.json';
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'trusted' });
    expect(fs.readFile).toHaveBeenLastCalledWith('/sandbox/two.json', 'utf8');
    env.AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY = '0';
    expect(await feature.getLaunchStatus(request)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'disabled' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
  });

  it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'EIO'])('maps %s to bounded states', async (code) => {
    vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error('secret path'), { code }));
    const status = code === 'ENOENT' || code === 'ENOTDIR' ? 'not_applicable' : 'unknown';
    expect(await createWorkspaceTrustStatusFeature(config).getLaunchStatus(request)).toEqual({
      providers: request.providerIds.map((providerId) => ({ providerId, status })),
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('rejects regular files as cwd', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect(await createWorkspaceTrustStatusFeature(config).getLaunchStatus(request)).toEqual({
      providers: request.providerIds.map((providerId) => ({
        providerId,
        status: 'not_applicable',
      })),
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('returns unknown when cwd disappears after realpath without reading config', async () => {
    vi.mocked(fs.stat)
      .mockResolvedValueOnce({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>)
      .mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await createWorkspaceTrustStatusFeature(config).getLaunchStatus(request)).toEqual(
      unknown
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('Codex-only reads no config or authentication files', async () => {
    expect(
      await createWorkspaceTrustStatusFeature(config).getLaunchStatus({
        ...request,
        providerIds: ['codex'],
      })
    ).toEqual({ providers: [{ providerId: 'codex', status: 'launch_scoped' }] });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('isolates a throwing Claude config getter from Codex', async () => {
    const claudeConfigDir = vi.fn(() => {
      throw new Error('private path');
    });
    const feature = createWorkspaceTrustStatusFeature({ ...config, claudeConfigDir });
    expect(await feature.getLaunchStatus({ ...request, providerIds: ['codex'] })).toEqual({
      providers: [{ providerId: 'codex', status: 'launch_scoped' }],
    });
    expect(claudeConfigDir).not.toHaveBeenCalled();
    expect(await feature.getLaunchStatus(request)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'unknown' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
  });

  it('preserves legacy path trimming without changing spaces inside paths', async () => {
    await createWorkspaceTrustStatusFeature(config).getProjectStatus({
      projectPath: '  /sandbox/a project/  ',
    });
    expect(fs.realpath).toHaveBeenCalledWith('/sandbox/a project/');
  });
});
