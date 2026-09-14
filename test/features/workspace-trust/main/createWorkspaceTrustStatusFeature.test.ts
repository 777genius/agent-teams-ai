import fs from 'node:fs/promises';

import { createNodeWorkspaceTrustFeatures } from '@main/composition/workspaceTrust/createNodeWorkspaceTrustFeatures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LaunchTrustRequest } from '@features/workspace-trust/contracts';
import type { WorkspaceTrustArgsOnlyPlanRequest } from '@features/workspace-trust/main';

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
  getClaudeConfigDir: () => '/sandbox',
  getAutoDetectedClaudeConfigDir: () => '/sandbox/auto-detected',
  env: {},
};
const createStatusFeature = (input = config) => createNodeWorkspaceTrustFeatures(input).status;
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
    const feature = createStatusFeature(config);
    expect(await feature.getLaunchStatus(value as LaunchTrustRequest)).toEqual(unknown);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('blocks local probing for remote context including legacy API and dynamic callbacks', async () => {
    const getHomeDir = vi.fn(config.getHomeDir);
    const getClaudeConfigDir = vi.fn(config.getClaudeConfigDir);
    const feature = createStatusFeature({
      ...config,
      getHomeDir,
      getClaudeConfigDir,
      isLocalContext: () => false,
    });
    expect(await feature.getLaunchStatus(request)).toEqual(unknown);
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'unknown' });
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(getHomeDir).not.toHaveBeenCalled();
    expect(getClaudeConfigDir).not.toHaveBeenCalled();
  });

  it('defers the launch coordinator binding until its first plan', async () => {
    const getClaudeConfigDir = vi.fn(config.getClaudeConfigDir);
    const feature = createNodeWorkspaceTrustFeatures({ ...config, getClaudeConfigDir });
    expect(getClaudeConfigDir).not.toHaveBeenCalled();

    const request: WorkspaceTrustArgsOnlyPlanRequest = {
      providers: ['codex'],
      workspaces: [],
      featureFlags: {
        enabled: true,
        claudePty: true,
        codexArgs: true,
        retry: false,
        fileLock: true,
      },
    };
    expect(await feature.coordinator.planArgsOnly(request)).toEqual({ launchArgPatches: [] });
    expect(getClaudeConfigDir).toHaveBeenCalledTimes(2);
    await feature.coordinator.planArgsOnly(request);
    expect(getClaudeConfigDir).toHaveBeenCalledTimes(2);
  });

  it('keeps flags, selected config and host callbacks fresh between requests', async () => {
    const env: NodeJS.ProcessEnv = {};
    let local = false;
    let configDir = '/sandbox/one';
    const feature = createStatusFeature({
      ...config,
      env,
      isLocalContext: () => local,
      getClaudeConfigDir: () => configDir,
    });
    expect(await feature.getLaunchStatus(request)).toEqual(unknown);
    local = true;
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'trusted' });
    expect(fs.readFile).toHaveBeenLastCalledWith('/sandbox/one/.claude.json', 'utf8');
    configDir = '/sandbox/two';
    expect(await feature.getProjectStatus(request)).toEqual({ status: 'trusted' });
    expect(fs.readFile).toHaveBeenLastCalledWith('/sandbox/two/.claude.json', 'utf8');
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
    expect(await createStatusFeature(config).getLaunchStatus(request)).toEqual({
      providers: request.providerIds.map((providerId) => ({ providerId, status })),
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('rejects regular files as cwd', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect(await createStatusFeature(config).getLaunchStatus(request)).toEqual({
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
    expect(await createStatusFeature(config).getLaunchStatus(request)).toEqual(unknown);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('Codex-only reads no config or authentication files', async () => {
    expect(
      await createStatusFeature(config).getLaunchStatus({
        ...request,
        providerIds: ['codex'],
      })
    ).toEqual({ providers: [{ providerId: 'codex', status: 'launch_scoped' }] });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('isolates a throwing Claude config getter from Codex', async () => {
    const getClaudeConfigDir = vi.fn(() => {
      throw new Error('private path');
    });
    const feature = createStatusFeature({ ...config, getClaudeConfigDir });
    expect(await feature.getLaunchStatus({ ...request, providerIds: ['codex'] })).toEqual({
      providers: [{ providerId: 'codex', status: 'launch_scoped' }],
    });
    expect(getClaudeConfigDir).not.toHaveBeenCalled();
    expect(await feature.getLaunchStatus(request)).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'unknown' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
  });

  it('preserves legacy path trimming without changing spaces inside paths', async () => {
    await createStatusFeature(config).getProjectStatus({
      projectPath: '  /sandbox/a project/  ',
    });
    expect(fs.realpath).toHaveBeenCalledWith('/sandbox/a project/');
  });
});
