import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildWorkspaceTrustPathCandidates,
  normalizeWorkspaceTrustConfigKey,
} from '@features/workspace-trust/core/domain';
import { NodePtyProcessAdapter } from '@features/workspace-trust/main/adapters/output/NodePtyProcessAdapter';
import { createWorkspaceTrustFeatures } from '@features/workspace-trust/main/composition/createWorkspaceTrustFeatures';
import { resolveWorkspaceTrustFeatureFlags } from '@features/workspace-trust/main/infrastructure/WorkspaceTrustFeatureFlags';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let home: string;
let defaultProfile: string;
let project: string;

describe('workspace trust profile composition', () => {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-trust-profile-')));
    home = path.join(root, 'home');
    defaultProfile = path.join(home, '.claude');
    project = path.join(root, 'owned-project');
    await Promise.all([defaultProfile, project].map((dir) => fs.mkdir(dir, { recursive: true })));
    vi.spyOn(NodePtyProcessAdapter.prototype, 'spawn').mockResolvedValue({
      ok: false,
      code: 'unexpected_pty',
      message: 'Profile composition tests must not launch a native process.',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function compose(env: NodeJS.ProcessEnv | undefined, getConfigDir = () => defaultProfile) {
    return createWorkspaceTrustFeatures({
      getClaudeConfigDir: getConfigDir,
      getAutoDetectedClaudeConfigDir: () => defaultProfile,
      getHomeDir: () => home,
      env,
    });
  }

  async function prepare(
    feature: ReturnType<typeof compose>,
    env: NodeJS.ProcessEnv,
    cwd = project
  ) {
    const result = await feature.coordinator.execute({
      providers: ['anthropic'],
      claudePath: path.join(root, 'unused-native-cli'),
      workspaces: buildWorkspaceTrustPathCandidates({ cwd, realCwd: cwd, homeDir: home }),
      env,
      featureFlags: resolveWorkspaceTrustFeatureFlags({}),
      isCancelled: () => false,
    });
    expect(NodePtyProcessAdapter.prototype.spawn).not.toHaveBeenCalled();
    return result;
  }

  async function expectTrustedFile(file: string) {
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      projects: { [normalizeWorkspaceTrustConfigKey(project)]: { hasTrustDialogAccepted: true } },
    });
  }

  it('persists and observes explicit default-directory trust in the file the CLI reads', async () => {
    const env = { CLAUDE_CONFIG_DIR: defaultProfile };
    const feature = compose(env);
    const nativeState = path.join(defaultProfile, '.claude.json');
    const implicitState = path.join(home, '.claude.json');

    expect(await prepare(feature, env)).toMatchObject({ status: 'ok' });
    await expectTrustedFile(nativeState);
    await expect(fs.stat(implicitState)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
      status: 'trusted',
    });
    await fs.unlink(nativeState);
    expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
      status: 'untrusted',
    });
  });

  it('does not claim trust from the implicit profile when an explicit profile is selected', async () => {
    const implicitState = path.join(home, '.claude.json');
    const unrelatedState = JSON.stringify({
      theme: 'dark',
      projects: { [normalizeWorkspaceTrustConfigKey(project)]: { hasTrustDialogAccepted: true } },
    });
    await fs.writeFile(implicitState, unrelatedState);
    const env = { CLAUDE_CONFIG_DIR: defaultProfile };
    const feature = compose(env);

    expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
      status: 'untrusted',
    });
    expect(await prepare(feature, env)).toMatchObject({ status: 'ok' });
    await expectTrustedFile(path.join(defaultProfile, '.claude.json'));
    expect(await fs.readFile(implicitState, 'utf8')).toBe(unrelatedState);
  });

  it.each([undefined, ''])(
    'preserves the implicit home state when the env value is %j',
    async (value) => {
      const env = { CLAUDE_CONFIG_DIR: value };
      const feature = compose(env);

      expect(await prepare(feature, env)).toMatchObject({ status: 'ok' });
      await expectTrustedFile(path.join(home, '.claude.json'));
      await expect(fs.stat(path.join(defaultProfile, '.claude.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
        status: 'trusted',
      });
    }
  );

  it('uses the live process environment when the composition does not inject one', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', defaultProfile);
    const feature = compose(undefined);

    expect(await prepare(feature, process.env)).toMatchObject({ status: 'ok' });
    await expectTrustedFile(path.join(defaultProfile, '.claude.json'));
    await expect(fs.stat(path.join(home, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps profile resolution fresh and preserves app-selected profile precedence', async () => {
    const env = { CLAUDE_CONFIG_DIR: defaultProfile };
    let selectedProfile = defaultProfile;
    const feature = compose(env, () => selectedProfile);
    expect(await prepare(feature, env)).toMatchObject({ status: 'ok' });

    env.CLAUDE_CONFIG_DIR = path.join(home, 'environment-profile');
    expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
      status: 'untrusted',
    });
    expect(await prepare(feature, env)).toMatchObject({ status: 'ok' });
    await expectTrustedFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'));

    selectedProfile = path.join(home, 'app-selected-profile');
    expect(await feature.status.getProjectStatus({ projectPath: project })).toEqual({
      status: 'untrusted',
    });
    expect(await prepare(feature, { CLAUDE_CONFIG_DIR: selectedProfile })).toMatchObject({
      status: 'ok',
    });
    await expectTrustedFile(path.join(selectedProfile, '.claude.json'));
    await expect(fs.stat(path.join(home, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps the home-directory refusal before either state file can be written', async () => {
    const env = { CLAUDE_CONFIG_DIR: defaultProfile };
    const feature = compose(env);
    expect(await prepare(feature, env, home)).toMatchObject({
      status: 'blocked',
      errorCode: 'workspace_trust_not_persistable_home_directory',
    });
    await expect(fs.stat(path.join(defaultProfile, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(home, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
