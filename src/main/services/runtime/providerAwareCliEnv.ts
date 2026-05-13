import { resolveVerifiedAppManagedCodexRuntimeBinaryPath } from '@features/codex-runtime-installer/main';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import { resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath } from '../infrastructure/OpenCodeRuntimeInstallerService';

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
  allowStoredApiKeyDecryption?: boolean;
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
  const storedApiKeyAccessArgs =
    options.allowStoredApiKeyDecryption === undefined
      ? []
      : [{ allowStoredApiKeyDecryption: options.allowStoredApiKeyDecryption }];
  const shellEnv = options.shellEnv ?? getCachedShellEnv() ?? {};
  const { env, resolvedProviderId } = buildRuntimeBaseEnv({
    binaryPath: options.binaryPath,
    providerId: options.providerId,
    providerBackendId: options.providerBackendId,
    shellEnv,
    env: options.env,
  });
  const appManagedOpenCodeBinary = await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath();
  if (
    appManagedOpenCodeBinary &&
    !env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH &&
    (!resolvedProviderId || resolvedProviderId === 'opencode')
  ) {
    env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = appManagedOpenCodeBinary;
  }
  const appManagedCodexBinary = await resolveVerifiedAppManagedCodexRuntimeBinaryPath();
  if (
    appManagedCodexBinary &&
    !env.CODEX_CLI_PATH &&
    (!resolvedProviderId || resolvedProviderId === 'codex')
  ) {
    env.CODEX_CLI_PATH = appManagedCodexBinary;
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
    await providerConnectionService.augmentAllConfiguredConnectionEnv(
      env,
      ...storedApiKeyAccessArgs
    );
    return {
      env,
      connectionIssues: {},
      providerArgs: [],
    };
  }

  await providerConnectionService.applyAllConfiguredConnectionEnv(env, ...storedApiKeyAccessArgs);
  return {
    env,
    connectionIssues: await providerConnectionService.getConfiguredConnectionIssues(env),
    providerArgs: [],
  };
}
