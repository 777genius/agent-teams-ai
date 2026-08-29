import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import {
  isAnthropicDirectCredentialAuthSource,
  type ProvisioningAuthSource,
  type ProvisioningEnvResolution,
} from './TeamProvisioningEnvBuilder';
import { isAuthFailureWarning, isQuotaRetryMessage } from './TeamProvisioningOutputErrorPolicy';

import type {
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';

function modelTargetKey(check: TeamProvisioningModelCheckRequest): string {
  return JSON.stringify({
    providerId: check.providerId,
    providerBackendId: Object.hasOwn(check, 'providerBackendId')
      ? (check.providerBackendId ?? null)
      : '<missing>',
    model: check.model.trim(),
    effort: check.effort ?? null,
  });
}

export async function runExactBackendOneShotDiagnostics(input: {
  providerId: TeamProviderId;
  providerLabel: string;
  providerCount: number;
  backendIds: readonly (TeamProviderBackendId | null | undefined)[];
  modelChecks?: readonly TeamProvisioningModelCheckRequest[];
  modelVerificationMode?: string;
  authSource: ProvisioningAuthSource;
  claudePath: string;
  cwd: string;
  buildProvisioningEnv(
    providerId: TeamProviderId,
    providerBackendId?: TeamProviderBackendId | null
  ): Promise<ProvisioningEnvResolution>;
  runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId,
    providerArgs: string[],
    exactCheck?: TeamProvisioningModelCheckRequest
  ): Promise<{ warning?: string; targetedLiveness?: TeamProvisioningModelCheckRequest }>;
}): Promise<{
  warnings: string[];
  blockingMessages: string[];
  targetedLivenessChecks: TeamProvisioningModelCheckRequest[];
}> {
  const warnings: string[] = [];
  const blockingMessages: string[] = [];
  const targetedLivenessChecks: TeamProvisioningModelCheckRequest[] = [];
  const exactChecks = input.modelChecks ?? [];
  const backendsToVerify = input.backendIds.length > 0 ? input.backendIds : [undefined];
  const prefix = (message: string): string =>
    input.providerCount > 1 ? `${input.providerLabel}: ${message}` : message;

  for (const backendId of backendsToVerify) {
    let envResolution: ProvisioningEnvResolution | null = null;
    const getEnv = async (): Promise<ProvisioningEnvResolution> => {
      envResolution ??= await input.buildProvisioningEnv(input.providerId, backendId);
      return envResolution;
    };
    let directAnthropicCredential = isAnthropicDirectCredentialAuthSource(input.authSource);
    if (resolveTeamProviderId(input.providerId) === 'anthropic' && !directAnthropicCredential) {
      const resolved = await getEnv();
      directAnthropicCredential = isAnthropicDirectCredentialAuthSource(resolved.authSource);
      if (resolved.authSource === 'configured_api_key_missing' && resolved.warning) {
        blockingMessages.push(prefix(resolved.warning));
        continue;
      }
    }
    if (input.modelVerificationMode !== 'deep' && !directAnthropicCredential) continue;

    const resolved = await getEnv();
    if (resolved.warning) {
      const warning = prefix(resolved.warning);
      if (resolved.authSource === 'configured_api_key_missing') blockingMessages.push(warning);
      else warnings.push(warning);
      continue;
    }
    const checksForBackend = exactChecks.filter(
      (check) => (check.providerBackendId ?? null) === (backendId ?? null)
    );
    const checksToExecute = checksForBackend.length > 0 ? checksForBackend : [undefined];
    for (const exactCheck of checksToExecute) {
      const diagnostic = exactCheck
        ? await input.runProviderOneShotDiagnostic(
            input.claudePath,
            input.cwd,
            resolved.env,
            input.providerId,
            resolved.providerArgs ?? [],
            exactCheck
          )
        : await input.runProviderOneShotDiagnostic(
            input.claudePath,
            input.cwd,
            resolved.env,
            input.providerId,
            resolved.providerArgs ?? []
          );
      if (exactCheck) {
        if (diagnostic.warning) {
          blockingMessages.push(prefix(diagnostic.warning));
          continue;
        }
        if (!diagnostic.targetedLiveness) {
          blockingMessages.push(
            prefix(
              `Model-targeted liveness for ${exactCheck.model} returned only a generic/default probe result.`
            )
          );
          continue;
        }
        if (modelTargetKey(diagnostic.targetedLiveness) !== modelTargetKey(exactCheck)) {
          blockingMessages.push(
            prefix(
              `Model-targeted liveness did not match the selected provider/backend/model/effort tuple for ${exactCheck.model}.`
            )
          );
          continue;
        }
        targetedLivenessChecks.push(exactCheck);
        continue;
      }
      if (!diagnostic.warning) continue;
      const warning = prefix(diagnostic.warning);
      if (
        (directAnthropicCredential && isAuthFailureWarning(diagnostic.warning, 'probe')) ||
        isQuotaRetryMessage(diagnostic.warning)
      ) {
        blockingMessages.push(warning);
      } else {
        warnings.push(warning);
      }
    }
  }
  return { warnings, blockingMessages, targetedLivenessChecks };
}
