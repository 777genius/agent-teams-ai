import { getCachedShellEnv } from '@main/utils/shellEnv';

import { buildRuntimeBaseEnv } from './buildRuntimeBaseEnv';
import { providerConnectionService } from './ProviderConnectionService';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;

export interface ProviderAwareCliEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  providerBackendId?: string | null;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  connectionMode?: 'strict' | 'augment';
}

export interface ProviderAwareCliEnvResult {
  env: NodeJS.ProcessEnv;
  connectionIssues: Partial<Record<CliProviderId, string>>;
  providerArgs: string[];
}

export async function buildProviderAwareCliEnv(
  options: ProviderAwareCliEnvOptions = {}
): Promise<ProviderAwareCliEnvResult> {
  const connectionMode = options.connectionMode ?? 'strict';
  const shellEnv = options.shellEnv ?? getCachedShellEnv() ?? {};
  const { env, resolvedProviderId } = buildRuntimeBaseEnv({
    binaryPath: options.binaryPath,
    providerId: options.providerId,
    providerBackendId: options.providerBackendId,
    shellEnv,
    env: options.env,
  });

  if (options.providerId) {
    if (!resolvedProviderId) {
      throw new Error('Resolved provider id is required when providerId is set');
    }
    if (connectionMode === 'augment') {
      await providerConnectionService.augmentConfiguredConnectionEnv(
        env,
        resolvedProviderId,
        options.providerBackendId
      );
      return {
        env,
        connectionIssues: {},
        providerArgs: [],
      };
    }

    await providerConnectionService.applyConfiguredConnectionEnv(
      env,
      resolvedProviderId,
      options.providerBackendId
    );

    return {
      env,
      providerArgs: await providerConnectionService.getConfiguredConnectionLaunchArgs(
        env,
        resolvedProviderId,
        options.providerBackendId,
        options.binaryPath
      ),
      connectionIssues: await providerConnectionService.getConfiguredConnectionIssues(
        env,
        [resolvedProviderId],
        resolvedProviderId === 'codex' || resolvedProviderId === 'gemini'
          ? { [resolvedProviderId]: options.providerBackendId?.trim() || undefined }
          : undefined
      ),
    };
  }

  if (connectionMode === 'augment') {
    await providerConnectionService.augmentAllConfiguredConnectionEnv(env);
    return {
      env,
      connectionIssues: {},
      providerArgs: [],
    };
  }

  await providerConnectionService.applyAllConfiguredConnectionEnv(env);
  return {
    env,
    connectionIssues: await providerConnectionService.getConfiguredConnectionIssues(env),
    providerArgs: [],
  };
}
