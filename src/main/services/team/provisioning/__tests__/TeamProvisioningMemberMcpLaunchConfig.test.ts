import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningMemberMcpLaunchConfigProvisioner,
  type TeamProvisioningMemberMcpRun,
} from '../TeamProvisioningMemberMcpLaunchConfig';

import type { RuntimeBootstrapMemberMcpLaunchConfig } from '../TeamProvisioningBootstrapSpec';
import type { TeamCreateRequest, TeamMemberMcpPolicy } from '@shared/types';

interface WriteCall {
  cwd?: string;
  options?: { mcpPolicy?: TeamMemberMcpPolicy; controlApiBaseUrl?: string | null };
}

class FakeMcpConfigBuilder {
  readonly writes: WriteCall[] = [];
  readonly removed: string[] = [];
  private sequence = 0;

  constructor(private readonly rootPath: string) {}

  async writeConfigFile(
    cwd?: string,
    options?: { mcpPolicy?: TeamMemberMcpPolicy; controlApiBaseUrl?: string | null }
  ): Promise<string> {
    this.writes.push({ cwd, options });
    this.sequence += 1;
    const configPath = path.join(this.rootPath, `member-mcp-${this.sequence}.json`);
    await writeFile(configPath, JSON.stringify({ cwd }), 'utf8');
    return configPath;
  }

  async removeConfigFile(configPath: string): Promise<void> {
    this.removed.push(configPath);
    await rm(configPath, { force: true });
  }
}

function createRun(
  overrides: Partial<TeamProvisioningMemberMcpRun> = {}
): TeamProvisioningMemberMcpRun {
  return {
    request: { cwd: '/repo/default' },
    memberMcpConfigPaths: [],
    processKilled: false,
    cancelRequested: false,
    ...overrides,
  };
}

describe('TeamProvisioningMemberMcpLaunchConfigProvisioner', () => {
  let tempDir: string;
  let builder: FakeMcpConfigBuilder;
  let aliveRun: TeamProvisioningMemberMcpRun | null;
  let ensuredCwds: string[];
  let resolveControlApiBaseUrl: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  let provisioner: TeamProvisioningMemberMcpLaunchConfigProvisioner<TeamProvisioningMemberMcpRun>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'member-mcp-launch-config-'));
    builder = new FakeMcpConfigBuilder(tempDir);
    aliveRun = null;
    ensuredCwds = [];
    resolveControlApiBaseUrl = vi.fn(async () => 'http://127.0.0.1:4567');
    provisioner = new TeamProvisioningMemberMcpLaunchConfigProvisioner({
      mcpConfigBuilder: builder,
      ensureCwdExists: async (cwd) => {
        ensuredCwds.push(cwd);
      },
      resolveControlApiBaseUrl,
      getAliveRun: () => aliveRun,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds runtime bootstrap configs only for members with MCP policy and tracks generated paths', async () => {
    const run = createRun({ memberMcpConfigPaths: undefined });
    const members: TeamCreateRequest['members'] = [
      { name: 'NoMcp' },
      {
        name: 'Scoped',
        cwd: ' /repo/scoped ',
        mcpPolicy: { mode: 'inheritScopes', scopes: { user: false, project: true, local: false } },
      },
      {
        name: 'Strict',
        mcpPolicy: { mode: 'appOnly' },
      },
    ];

    const configs = await provisioner.buildRuntimeBootstrapMemberMcpLaunchConfigs({
      cwd: '/repo/root',
      members,
      run,
      controlApiBaseUrl: 'http://control.test',
    });

    expect([...configs.keys()]).toEqual(['Scoped', 'Strict']);
    expect(configs.get('Scoped')).toEqual({
      mcpConfigPath: path.join(tempDir, 'member-mcp-1.json'),
      mcpSettingSources: 'project',
      strictMcpConfig: false,
    });
    expect(configs.get('Strict')).toEqual({
      mcpConfigPath: path.join(tempDir, 'member-mcp-2.json'),
      mcpSettingSources: 'user,project,local',
      strictMcpConfig: true,
    });
    expect(run.memberMcpConfigPaths).toEqual([
      path.join(tempDir, 'member-mcp-1.json'),
      path.join(tempDir, 'member-mcp-2.json'),
    ]);
    expect(builder.writes.map((call) => call.cwd)).toEqual(['/repo/scoped', '/repo/root']);
    expect(builder.writes.map((call) => call.options?.controlApiBaseUrl)).toEqual([
      'http://control.test',
      'http://control.test',
    ]);
  });

  it('returns null and avoids writes for missing tracked MCP policy', async () => {
    const run = createRun();

    await expect(
      provisioner.buildTrackedMemberMcpLaunchConfig({
        cwd: '/repo/root',
        mcpPolicy: undefined,
        run,
      })
    ).resolves.toBeNull();

    expect(builder.writes).toEqual([]);
    expect(run.memberMcpConfigPaths).toEqual([]);
  });

  it('removes tracked configs from run state and from disk', async () => {
    const run = createRun();
    const config = await provisioner.buildTrackedMemberMcpLaunchConfig({
      cwd: '/repo/root',
      mcpPolicy: { mode: 'strictAllowlist', serverNames: ['agent-teams'] },
      run,
      controlApiBaseUrl: 'http://control.test',
    });

    await provisioner.removeTrackedMemberMcpLaunchConfig(run, config);

    expect(run.memberMcpConfigPaths).toEqual([]);
    expect(builder.removed).toEqual([config?.mcpConfigPath]);
  });

  it('prepares live configs through the run lookup, cwd guard, and control API resolver', async () => {
    aliveRun = createRun({ request: { cwd: path.join(tempDir, 'project') } });

    const config = await provisioner.prepareLiveMemberMcpLaunchConfig({
      teamName: 'Team',
      cwd: '  ',
      mcpPolicy: { mode: 'appOnly' },
    });

    expect(config).toEqual({
      mcpConfigPath: path.join(tempDir, 'member-mcp-1.json'),
      mcpSettingSources: 'user,project,local',
      strictMcpConfig: true,
    });
    expect(ensuredCwds).toEqual([path.join(tempDir, 'project')]);
    expect(resolveControlApiBaseUrl).toHaveBeenCalledOnce();
    expect(builder.writes[0]?.options?.controlApiBaseUrl).toBe('http://127.0.0.1:4567');
    expect(aliveRun.memberMcpConfigPaths).toEqual([path.join(tempDir, 'member-mcp-1.json')]);
  });

  it('rejects live config preparation when no active run or project path is available', async () => {
    await expect(
      provisioner.prepareLiveMemberMcpLaunchConfig({
        teamName: 'Team',
        mcpPolicy: { mode: 'appOnly' },
      })
    ).rejects.toThrow('Team "Team" is not currently running');

    aliveRun = createRun({ request: { cwd: ' ' } });
    await expect(
      provisioner.prepareLiveMemberMcpLaunchConfig({
        teamName: 'Team',
        mcpPolicy: { mode: 'appOnly' },
      })
    ).rejects.toThrow('Team "Team" project path is not available');
  });

  it('discards live configs from tracked runs or directly when the run is gone', async () => {
    aliveRun = createRun();
    const trackedConfig = await provisioner.buildTrackedMemberMcpLaunchConfig({
      cwd: '/repo/root',
      mcpPolicy: { mode: 'appOnly' },
      run: aliveRun,
    });

    await provisioner.discardLiveMemberMcpLaunchConfig({
      teamName: 'Team',
      mcpLaunchConfig: trackedConfig,
    });

    expect(aliveRun.memberMcpConfigPaths).toEqual([]);
    expect(builder.removed).toEqual([trackedConfig?.mcpConfigPath]);

    aliveRun = null;
    const orphanConfig: RuntimeBootstrapMemberMcpLaunchConfig = {
      mcpConfigPath: path.join(tempDir, 'orphan.json'),
      mcpSettingSources: 'user,project,local',
      strictMcpConfig: true,
    };
    await writeFile(orphanConfig.mcpConfigPath, '{}', 'utf8');

    await provisioner.discardLiveMemberMcpLaunchConfig({
      teamName: 'Team',
      mcpLaunchConfig: orphanConfig,
    });

    expect(builder.removed).toEqual([trackedConfig?.mcpConfigPath, orphanConfig.mcpConfigPath]);
  });

  it('removes all run-scoped member config files immediately or in the later cleanup path', async () => {
    const immediateRun = createRun({
      memberMcpConfigPaths: [
        path.join(tempDir, 'immediate-a.json'),
        path.join(tempDir, 'immediate-b.json'),
      ],
    });
    await Promise.all(
      immediateRun.memberMcpConfigPaths?.map((configPath) => writeFile(configPath, '{}', 'utf8')) ??
        []
    );

    await provisioner.removeRunMemberMcpConfigFiles(immediateRun);

    expect(immediateRun.memberMcpConfigPaths).toEqual([]);
    expect(builder.removed).toEqual([
      path.join(tempDir, 'immediate-a.json'),
      path.join(tempDir, 'immediate-b.json'),
    ]);

    const laterRun = createRun({
      memberMcpConfigPaths: [
        path.join(tempDir, 'later-a.json'),
        path.join(tempDir, 'later-b.json'),
      ],
    });
    await Promise.all(
      laterRun.memberMcpConfigPaths?.map((configPath) => writeFile(configPath, '{}', 'utf8')) ?? []
    );

    provisioner.removeRunMemberMcpConfigFilesLater(laterRun);

    expect(laterRun.memberMcpConfigPaths).toEqual([]);
    expect(builder.removed.slice(2)).toEqual([
      path.join(tempDir, 'later-a.json'),
      path.join(tempDir, 'later-b.json'),
    ]);
  });
});
