import { describe, expect, it } from 'vitest';

import {
  buildCodexChatGptUnsupportedModelReason,
  CODEX_CHATGPT_UNSUPPORTED_MODEL_NORMALIZED_REASON,
  getCodexChatGptUnavailableModelReason,
  isCodexChatGptAuthProviderStatus,
  isCodexChatGptUnsupportedModelMessage,
} from '../codexChatGptModelSupport';

import type { CliProviderStatus } from '@shared/types';

// Exact live-repro signature: codex exec fails with 400 invalid_request_error
// for a ChatGPT-gated model that is still listed in the live model catalog.
const REPRO_SIGNATURE =
  "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.";

describe('isCodexChatGptUnsupportedModelMessage', () => {
  it('matches the exact repro signature', () => {
    expect(isCodexChatGptUnsupportedModelMessage(REPRO_SIGNATURE)).toBe(true);
  });

  it('matches the signature embedded in a larger runtime error', () => {
    expect(
      isCodexChatGptUnsupportedModelMessage(
        `Command failed: codex exec\nAPI error 400 (invalid_request_error): ${REPRO_SIGNATURE}`
      )
    ).toBe(true);
  });

  it('matches a generic invalid_request_error about an unsupported model', () => {
    expect(
      isCodexChatGptUnsupportedModelMessage(
        'invalid_request_error: model gpt-9-codex is unsupported for this account type'
      )
    ).toBe(true);
  });

  it('rejects unrelated failures', () => {
    expect(isCodexChatGptUnsupportedModelMessage('')).toBe(false);
    expect(isCodexChatGptUnsupportedModelMessage(null)).toBe(false);
    expect(isCodexChatGptUnsupportedModelMessage('Timeout running: codex exec')).toBe(false);
    expect(isCodexChatGptUnsupportedModelMessage('401 unauthorized: token expired')).toBe(false);
    expect(
      isCodexChatGptUnsupportedModelMessage('invalid_request_error: temperature out of range')
    ).toBe(false);
  });
});

describe('isCodexChatGptAuthProviderStatus', () => {
  it('detects ChatGPT auth from authMethod, backend detail, and connection mode', () => {
    expect(isCodexChatGptAuthProviderStatus({ providerId: 'codex', authMethod: 'chatgpt' })).toBe(
      true
    );
    expect(
      isCodexChatGptAuthProviderStatus({
        providerId: 'codex',
        backend: { kind: 'codex-native', label: 'Codex', authMethodDetail: 'chatgpt' },
      })
    ).toBe(true);
    expect(
      isCodexChatGptAuthProviderStatus({
        connection: {
          codex: { effectiveAuthMode: 'chatgpt' },
        } as CliProviderStatus['connection'],
      })
    ).toBe(true);
  });

  it('rejects non-ChatGPT or non-codex statuses', () => {
    expect(isCodexChatGptAuthProviderStatus(null)).toBe(false);
    expect(isCodexChatGptAuthProviderStatus({ providerId: 'codex', authMethod: 'api_key' })).toBe(
      false
    );
    expect(
      isCodexChatGptAuthProviderStatus({ providerId: 'anthropic', authMethod: 'chatgpt' })
    ).toBe(false);
  });
});

describe('getCodexChatGptUnavailableModelReason', () => {
  const chatGptStatus = {
    providerId: 'codex' as const,
    authMethod: 'chatgpt',
  };

  it('returns the unsupported reason for a probe failure carrying the raw signature', () => {
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          ...chatGptStatus,
          modelAvailability: [
            { modelId: 'gpt-5.2', status: 'unavailable', reason: REPRO_SIGNATURE },
          ],
        },
        modelId: 'gpt-5.2',
      })
    ).toBe(buildCodexChatGptUnsupportedModelReason('gpt-5.2'));
  });

  it('accepts the normalized native-runtime reason while in ChatGPT mode', () => {
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          ...chatGptStatus,
          modelAvailability: [
            {
              modelId: 'gpt-5.2',
              status: 'unavailable',
              reason: CODEX_CHATGPT_UNSUPPORTED_MODEL_NORMALIZED_REASON,
            },
          ],
        },
        modelId: 'gpt-5.2',
      })
    ).toBe(buildCodexChatGptUnsupportedModelReason('gpt-5.2'));
  });

  it('stays null outside ChatGPT mode, for other models, and for unrelated failures', () => {
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          providerId: 'codex',
          authMethod: 'api_key',
          modelAvailability: [
            { modelId: 'gpt-5.2', status: 'unavailable', reason: REPRO_SIGNATURE },
          ],
        },
        modelId: 'gpt-5.2',
      })
    ).toBeNull();
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          ...chatGptStatus,
          modelAvailability: [
            { modelId: 'gpt-5.2', status: 'unavailable', reason: REPRO_SIGNATURE },
          ],
        },
        modelId: 'gpt-5.6-sol',
      })
    ).toBeNull();
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          ...chatGptStatus,
          modelAvailability: [
            { modelId: 'gpt-5.2', status: 'unavailable', reason: 'Model verification timed out' },
          ],
        },
        modelId: 'gpt-5.2',
      })
    ).toBeNull();
    expect(
      getCodexChatGptUnavailableModelReason({
        providerStatus: {
          ...chatGptStatus,
          modelAvailability: [{ modelId: 'gpt-5.2', status: 'available', reason: null }],
        },
        modelId: 'gpt-5.2',
      })
    ).toBeNull();
  });
});
