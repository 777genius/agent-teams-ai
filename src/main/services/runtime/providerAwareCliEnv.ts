import { resolveVerifiedAppManagedCodexRuntimeBinaryPath } from '@features/codex-runtime-installer/main';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import {
  isSupportedOpenCodeRuntimeBinaryPath,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '../infrastructure/OpenCodeRuntimeInstallerService';

import { ensureAgentTeamsMcpLocalLaunchEnv } from './agentTeamsMcpLaunchEnv';
import { buildRuntimeBaseEnv } from './buildRuntimeBaseEnv';
import {
  applyOpenCodeRuntimeBinaryEnv,
  OPENCODE_LEGACY_BINARY_PATH_ENV,
  OPENCODE_RUNTIME_BINARY_PATH_ENV,
} from './openCodeRuntimeBinaryEnv';
import { providerConnectionService } from './ProviderConnectionService';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
const PROVIDER_STATUS_STORED_CREDENTIAL_ALLOWLIST = {
  anthropic: ['ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
} as const;
const AGGREGATE_PROVIDER_STATUS_STORED_CREDENTIAL_ALLOWLIST = [
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

export interface ProviderAwareCliEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  providerBackendId?: string | null;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  connectionMode?: 'strict' | 'augment';
  allowStoredApiKeyDecryption?: boolean;
  allowedStoredApiKeyEnvVarNames?: readonly string[];
  allowClaudeUserSettingsAuthEnv?: boolean;
}

export interface ProviderAwareCliEnvResult {
  env: NodeJS.ProcessEnv;
  connectionIssues: Partial<Record<CliProviderId, string>>;
  providerArgs: string[];
}

export function getProviderStatusStoredCredentialAllowlist(
  providerId: ProviderEnvTargetId
): readonly string[] | undefined {
  if (providerId === 'anthropic' || providerId === 'codex') {
    return PROVIDER_STATUS_STORED_CREDENTIAL_ALLOWLIST[providerId];
  }

  return undefined;
}

export function getAggregateProviderStatusStoredCredentialAllowlist(): readonly string[] {
  return AGGREGATE_PROVIDER_STATUS_STORED_CREDENTIAL_ALLOWLIST;
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
    options.allowedStoredApiKeyEnvVarNames === undefined &&
    options.allowClaudeUserSettingsAuthEnv === undefined
      ? []
      : [
          {
            allowStoredApiKeyDecryption: options.allowStoredApiKeyDecryption,
            allowedStoredApiKeyEnvVarNames: options.allowedStoredApiKeyEnvVarNames,
            allowClaudeUserSettingsAuthEnv: options.allowClaudeUserSettingsAuthEnv,
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
    const explicitOpenCodeBinary = [
      options.env?.[OPENCODE_RUNTIME_BINARY_PATH_ENV],
      options.env?.[OPENCODE_LEGACY_BINARY_PATH_ENV],
      process.env[OPENCODE_RUNTIME_BINARY_PATH_ENV],
      process.env[OPENCODE_LEGACY_BINARY_PATH_ENV],
    ]
      .find((candidate): candidate is string => Boolean(candidate?.trim()))
      ?.trim();
    const supportedExplicitOpenCodeBinary =
      explicitOpenCodeBinary &&
      (await isSupportedOpenCodeRuntimeBinaryPath(explicitOpenCodeBinary).catch(() => false))
        ? explicitOpenCodeBinary
        : null;
    const openCodeBinary =
      supportedExplicitOpenCodeBinary ?? (await resolveVerifiedOpenCodeRuntimeBinaryPath());
    if (openCodeBinary) {
      // Login-shell snapshots can contain an older OpenCode override than the
      // app-managed runtime shown in the UI. Keep deliberate process/call
      // overrides, otherwise make the verified runtime authoritative.
      delete env[OPENCODE_RUNTIME_BINARY_PATH_ENV];
      delete env[OPENCODE_LEGACY_BINARY_PATH_ENV];
    }
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
    const aggregateAugmentOptions = {
      ...(storedApiKeyAccessArgs[0] ?? {}),
      allowClaudeUserSettingsAuthEnv: options.allowClaudeUserSettingsAuthEnv ?? false,
    };
    await providerConnectionService.augmentAllConfiguredConnectionEnv(env, aggregateAugmentOptions);
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
