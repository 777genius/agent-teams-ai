import { execFile } from 'child_process';
import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

const liveDescribe =
  process.env.OPENCODE_DEFAULT_MODEL_RESOLUTION_LIVE_E2E === '1' ? describe : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const execFileAsync = promisify(execFile);

interface ProviderModelListResponse {
  providers?: {
    opencode?: {
      defaultModel?: string;
      models?: Array<{ id?: string }>;
    };
  };
}

interface RuntimeStatusResponse {
  providers?: {
    opencode?: {
      models?: string[];
      modelCatalog?: {
        defaultLaunchModel?: string | null;
        models?: Array<{ id?: string; launchModel?: string; displayName?: string }>;
      };
    };
  };
}

type DefaultModelResolver = {
  resolveProviderDefaultModel: (
    claudePath: string,
    cwd: string,
    providerId: string,
    env: NodeJS.ProcessEnv,
    providerArgs: string[],
    limitContext: boolean
  ) => Promise<string | null>;
  materializeEffectiveTeamMemberSpecs: (params: {
    claudePath: string;
    cwd: string;
    members: Array<{ name: string; providerId: 'opencode'; model?: string }>;
    defaults: { providerId: 'anthropic' };
    primaryProviderId: 'opencode';
    primaryEnv: {
      env: NodeJS.ProcessEnv;
      authSource: string;
      providerArgs: string[];
      geminiRuntimeAuth: null;
    };
    providerArgsResolver: () => string[];
    limitContext: boolean;
  }) => Promise<Array<{ name: string; providerId: 'opencode'; model?: string }>>;
};

liveDescribe('OpenCode default model resolution live e2e', () => {
  it('materializes an OpenCode Default teammate through the real model-list pipe', async () => {
    const orchestratorCli =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    await assertExecutable(orchestratorCli);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: withBunOnPath(process.env.PATH ?? ''),
      OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
    };
    const svc = new TeamProvisioningService() as unknown as DefaultModelResolver;

    const defaultModel = await svc.resolveProviderDefaultModel(
      orchestratorCli,
      process.cwd(),
      'opencode',
      env,
      [],
      false
    );

    expect(defaultModel).toMatch(/^opencode\/.+/);

    await expect(
      svc.materializeEffectiveTeamMemberSpecs({
        claudePath: orchestratorCli,
        cwd: process.cwd(),
        members: [{ name: 'atlas', providerId: 'opencode' }],
        defaults: { providerId: 'anthropic' },
        primaryProviderId: 'opencode',
        primaryEnv: {
          env,
          authSource: 'opencode_managed',
          providerArgs: [],
          geminiRuntimeAuth: null,
        },
        providerArgsResolver: () => [],
        limitContext: false,
      })
    ).resolves.toEqual([{ name: 'atlas', providerId: 'opencode', model: defaultModel }]);
  }, 60_000);

  it('keeps the real OpenCode catalog hydrated instead of summary-only big-pickle', async () => {
    const orchestratorCli =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    await assertExecutable(orchestratorCli);

    const env = buildOpenCodeLiveEnv();
    const modelList = await runJsonCommand<ProviderModelListResponse>(
      orchestratorCli,
      ['model', 'list', '--json', '--provider', 'opencode'],
      env
    );
    const modelListIds =
      modelList.providers?.opencode?.models
        ?.map((model) => model.id?.trim())
        .filter((id): id is string => Boolean(id)) ?? [];

    expect(modelList.providers?.opencode?.defaultModel).toBe('opencode/big-pickle');
    expect(modelListIds.length).toBeGreaterThan(50);
    expect(modelListIds).toContain('opencode/big-pickle');
    expect(modelListIds.some((id) => id !== 'opencode/big-pickle')).toBe(true);

    const runtimeStatus = await runJsonCommand<RuntimeStatusResponse>(
      orchestratorCli,
      ['runtime', 'status', '--json', '--provider', 'opencode'],
      env
    );
    const provider = runtimeStatus.providers?.opencode;
    const catalogIds =
      provider?.modelCatalog?.models
        ?.map((model) => model.launchModel?.trim() || model.id?.trim())
        .filter((id): id is string => Boolean(id)) ?? [];

    expect(provider?.modelCatalog?.defaultLaunchModel).toBe('opencode/big-pickle');
    expect(provider?.models?.length ?? 0).toBeGreaterThan(50);
    expect(catalogIds.length).toBeGreaterThan(50);
    expect(catalogIds).toContain('opencode/big-pickle');
  }, 90_000);
});

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
}

function withBunOnPath(value: string): string {
  const candidates = [
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin') : null,
    process.env.HOME ? path.join(process.env.HOME, '.bun', 'bin') : null,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...candidates, value].join(path.delimiter);
}

function buildOpenCodeLiveEnv(): NodeJS.ProcessEnv {
  const realHome = os.userInfo().homedir;
  return {
    ...process.env,
    HOME: realHome,
    USERPROFILE: realHome,
    PATH: withBunOnPath(process.env.PATH ?? ''),
    OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? '1',
  };
}

async function runJsonCommand<T>(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<T> {
  const { stdout } = await execFileAsync(binaryPath, args, {
    cwd: process.cwd(),
    env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
