import { describe, expect, it } from 'vitest';

import {
  CODEX_CHATGPT_UNSUPPORTED_MODEL_UI_DISABLED_REASON,
  getRuntimeAwareTeamModelUiDisabledReason,
  getVisibleTeamProviderModels,
  GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON,
} from '../teamModelCatalog';

import type { CliProviderModelAvailability } from '@shared/types';

const REPRO_SIGNATURE =
  "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.";

function buildCodexStatus(params: {
  authMethod: string;
  modelAvailability?: CliProviderModelAvailability[];
}): {
  providerId: 'codex';
  authMethod: string;
  backend: null;
  connection: null;
  modelCatalog: null;
  modelAvailability?: CliProviderModelAvailability[];
} {
  return {
    providerId: 'codex',
    authMethod: params.authMethod,
    backend: null,
    connection: null,
    modelCatalog: null,
    ...(params.modelAvailability ? { modelAvailability: params.modelAvailability } : {}),
  };
}

describe('codex ChatGPT-mode model gating in the team model catalog', () => {
  const chatGptStatusWithGatedModel = buildCodexStatus({
    authMethod: 'chatgpt',
    modelAvailability: [{ modelId: 'gpt-5.2', status: 'unavailable', reason: REPRO_SIGNATURE }],
  });

  it('disables a probe-flagged model with the ChatGPT-specific reason', () => {
    expect(
      getRuntimeAwareTeamModelUiDisabledReason('codex', 'gpt-5.2', chatGptStatusWithGatedModel)
    ).toBe(CODEX_CHATGPT_UNSUPPORTED_MODEL_UI_DISABLED_REASON);
  });

  it('keeps the static gpt-5.1-codex-max ChatGPT gate and its original reason', () => {
    expect(
      getRuntimeAwareTeamModelUiDisabledReason(
        'codex',
        'gpt-5.1-codex-max',
        buildCodexStatus({ authMethod: 'chatgpt' })
      )
    ).toBe(GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON);
  });

  it('leaves the model enabled outside ChatGPT auth or without a probe verdict', () => {
    expect(
      getRuntimeAwareTeamModelUiDisabledReason(
        'codex',
        'gpt-5.2',
        buildCodexStatus({
          authMethod: 'api_key',
          modelAvailability: [
            { modelId: 'gpt-5.2', status: 'unavailable', reason: REPRO_SIGNATURE },
          ],
        })
      )
    ).toBeNull();
    expect(
      getRuntimeAwareTeamModelUiDisabledReason(
        'codex',
        'gpt-5.2',
        buildCodexStatus({ authMethod: 'chatgpt' })
      )
    ).toBeNull();
  });

  it('hides probe-flagged models from the visible ChatGPT-mode model list', () => {
    expect(
      getVisibleTeamProviderModels('codex', ['gpt-5.6-sol', 'gpt-5.2'], chatGptStatusWithGatedModel)
    ).not.toContain('gpt-5.2');
    expect(
      getVisibleTeamProviderModels(
        'codex',
        ['gpt-5.6-sol', 'gpt-5.2'],
        buildCodexStatus({ authMethod: 'api_key' })
      )
    ).toContain('gpt-5.2');
  });
});
