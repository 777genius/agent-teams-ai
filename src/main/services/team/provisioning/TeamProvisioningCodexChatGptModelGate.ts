import {
  type CodexChatGptAwareProviderStatus,
  getCodexChatGptUnavailableModelReason,
  isCodexChatGptAuthProviderStatus,
  isCodexChatGptUnsupportedModelMessage,
} from '@shared/utils/codexChatGptModelSupport';
import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  buildProviderModelProbeArgs,
  getProviderModelProbeTimeoutMs,
  isProviderModelProbeSuccessOutput,
} from '../../runtime/providerModelProbe';

import { TeamLaunchValidationError } from './TeamLaunchValidationError';
import { getExplicitLaunchModelSelection } from './TeamProvisioningMemberSpecs';

import type { TeamProviderId } from '@shared/types';

export type CodexChatGptModelSupportProbeResult =
  | { outcome: 'supported' }
  | { outcome: 'unsupported'; message: string }
  | { outcome: 'inconclusive' };

export interface CodexChatGptModelSupportProbeInput {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerArgs?: string[];
  modelId: string;
}

export type CodexChatGptModelSupportProbe = (
  input: CodexChatGptModelSupportProbeInput
) => Promise<CodexChatGptModelSupportProbeResult>;

export interface CodexChatGptModelSupportProbePorts {
  execCli(
    binaryPath: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
  ): Promise<{ stdout: string; stderr?: string }>;
}

/**
 * One-shot availability probe for the selected Codex model. A ChatGPT-gated
 * model fails with the invalid_request_error signature ("The 'X' model is not
 * supported when using Codex with a ChatGPT account."); any other failure is
 * inconclusive so unrelated runtime hiccups never block a launch.
 */
export function createCodexChatGptModelSupportProbe(
  ports: CodexChatGptModelSupportProbePorts
): CodexChatGptModelSupportProbe {
  return async (input) => {
    try {
      const { stdout, stderr } = await ports.execCli(
        input.claudePath,
        [...(input.providerArgs ?? []), ...buildProviderModelProbeArgs(input.modelId)],
        {
          cwd: input.cwd,
          env: input.env,
          timeout: getProviderModelProbeTimeoutMs('codex'),
        }
      );
      const combinedOutput = `${stdout}\n${stderr ?? ''}`.trim();
      if (isCodexChatGptUnsupportedModelMessage(combinedOutput)) {
        return { outcome: 'unsupported', message: combinedOutput };
      }
      if (isProviderModelProbeSuccessOutput(combinedOutput)) {
        return { outcome: 'supported' };
      }
      return { outcome: 'inconclusive' };
    } catch (error) {
      const message = getErrorMessage(error).trim();
      if (isCodexChatGptUnsupportedModelMessage(message)) {
        return { outcome: 'unsupported', message };
      }
      return { outcome: 'inconclusive' };
    }
  };
}

export function shouldProbeCodexChatGptModelSupport(params: {
  providerId: TeamProviderId;
  model: string | undefined;
  providerStatus: CodexChatGptAwareProviderStatus | undefined;
}): string | null {
  if (params.providerId !== 'codex') {
    return null;
  }
  const explicitModel = getExplicitLaunchModelSelection(params.model);
  // The Codex catalog exposes a literal "default" selection next to the shared
  // __provider_default__ sentinel; both mean "let the runtime pick", so there
  // is no concrete model id to probe with `codex exec --model`.
  if (
    !explicitModel ||
    explicitModel.toLowerCase() === 'default' ||
    !isCodexChatGptAuthProviderStatus(params.providerStatus)
  ) {
    return null;
  }
  return explicitModel;
}

/**
 * Launch blocker shared by launch-identity validation: throws when the runtime
 * availability facts flag the explicitly selected Codex model as unusable with
 * the currently authenticated ChatGPT account. The thrown message carries the
 * runtime's own reason so the user sees why the model was refused, and the
 * typed validation error keeps the HTTP surface on its 422 contract.
 */
export function assertCodexChatGptLaunchModelSupported(params: {
  actorLabel: string;
  explicitModel: string | undefined;
  providerStatus: CodexChatGptAwareProviderStatus | undefined;
}): void {
  if (!params.explicitModel) {
    return;
  }
  const chatGptUnavailableReason = getCodexChatGptUnavailableModelReason({
    providerStatus: params.providerStatus,
    modelId: params.explicitModel,
  });
  if (chatGptUnavailableReason) {
    throw new TeamLaunchValidationError(
      `${params.actorLabel} uses Codex model "${params.explicitModel}", but the Codex runtime reports: ${chatGptUnavailableReason}`
    );
  }
}
