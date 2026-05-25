import { resolveVerifiedAppManagedCodexRuntimeBinaryPath } from '@features/codex-runtime-installer/main';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import { resolveVerifiedOpenCodeRuntimeBinaryPath } from '../infrastructure/OpenCodeRuntimeInstallerService';

import { ensureAgentTeamsMcpLocalLaunchEnv } from './agentTeamsMcpLaunchEnv';
import { buildRuntimeBaseEnv } from './buildRuntimeBaseEnv';
import { applyOpenCodeRuntimeBinaryEnv } from './openCodeRuntimeBinaryEnv';
import { providerConnectionService } from './ProviderConnectionService';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

export interface ProviderAwareCliEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  providerBackendId?: string | null;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  connectionMode?: 'strict' | 'augment';
  allowStoredApiKeyDecryption?: boolean;
  allowedStoredApiKeyEnvVarNames?: readonly string[];
}

export interface ProviderAwareCliEnvResult {
  env: NodeJS.ProcessEnv;
  connectionIssues: Partial<Record<CliProviderId, string>>;
  providerArgs: string[];
}

function removeGlobalElectronRunAsNodeEnv(env: NodeJS.ProcessEnv): void {
  delete env[ELECTRON_RUN_AS_NODE_ENV];
}

export async function buildProviderAwareCliEnv(
  options: ProviderAwareCliEnvOptions = {}
): Promise<ProviderAwareCliEnvResult> {
  const connectionMode = options.connectionMode ?? 'strict';
  const storedApiKeyAccessArgs =
    options.allowStoredApiKeyDecryption === undefined &&
    options.allowedStoredApiKeyEnvVarNames === undefined
      ? []
      : [
          {
            allowStoredApiKeyDecryption: options.allowStoredApiKeyDecryption,
            allowedStoredApiKeyEnvVarNames: options.allowedStoredApiKeyEnvVarNames,
          },
        ];
  const shellEnv = options.shellEnv ?? getCachedShellEnv() ?? {};
  const { env, resolvedProviderId } = buildRuntimeBaseEnv({
    binaryPath: options.binaryPath,
    providerId: options.providerId,
    providerBackendId: options.providerBackendId,
    shellEnv,
    env: options.env,
    mergePathFallbacks: true,
  });
  if (!resolvedProviderId || resolvedProviderId === 'opencode') {
    const openCodeBinary = await resolveVerifiedOpenCodeRuntimeBinaryPath();
    applyOpenCodeRuntimeBinaryEnv(env, openCodeBinary);
  }
  const appManagedCodexBinary = await resolveVerifiedAppManagedCodexRuntimeBinaryPath();
  if (
    appManagedCodexBinary &&
    !env.CODEX_CLI_PATH &&
    (!resolvedProviderId || resolvedProviderId === 'codex')
  ) {
    env.CODEX_CLI_PATH = appManagedCodexBinary;
  }
  if (!resolvedProviderId || resolvedProviderId === 'opencode') {
    await ensureAgentTeamsMcpLocalLaunchEnv(env);
  }

  if (options.providerId) {
    if (!resolvedProviderId) {
      throw new Error('Resolved provider id is required when providerId is set');
    }
    if (connectionMode === 'augment') {
      await providerConnectionService.augmentConfiguredConnectionEnv(
        env,
        resolvedProviderId,
        options.providerBackendId,
        ...storedApiKeyAccessArgs
      );
      removeGlobalElectronRunAsNodeEnv(env);
      return {
        env,
        connectionIssues: {},
        providerArgs: [],
      };
    }

    await providerConnectionService.applyConfiguredConnectionEnv(
      env,
      resolvedProviderId,
      options.providerBackendId,
      ...storedApiKeyAccessArgs
    );
    removeGlobalElectronRunAsNodeEnv(env);

    const providerArgs = await providerConnectionService.getConfiguredConnectionLaunchArgs(
      env,
      resolvedProviderId,
      options.providerBackendId,
      options.binaryPath
    );
    const connectionIssues = await providerConnectionService.getConfiguredConnectionIssues(
      env,
      [resolvedProviderId],
      resolvedProviderId === 'codex' || resolvedProviderId === 'gemini'
        ? { [resolvedProviderId]: options.providerBackendId?.trim() || undefined }
        : undefined
    );
    return {
      env,
      providerArgs,
      connectionIssues,
    };
  }

  if (connectionMode === 'augment') {
    await providerConnectionService.augmentAllConfiguredConnectionEnv(
      env,
      ...storedApiKeyAccessArgs
    );
    removeGlobalElectronRunAsNodeEnv(env);
    return {
      env,
      connectionIssues: {},
      providerArgs: [],
    };
  }

  await providerConnectionService.applyAllConfiguredConnectionEnv(env, ...storedApiKeyAccessArgs);
  removeGlobalElectronRunAsNodeEnv(env);
  const connectionIssues = await providerConnectionService.getConfiguredConnectionIssues(env);
  return {
    env,
    connectionIssues,
    providerArgs: [],
  };
}
