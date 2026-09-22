import { describe, expect, it } from 'vitest';

import { isOpenCodeProviderVerifyFailure } from '../../../../src/features/runtime-provider-management/main/infrastructure/openCodeConnectVerifyFailure';

import type {
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementProviderResponse,
} from '../../../../src/features/runtime-provider-management/contracts';

const LIVE_VERIFY_FAILURE_MESSAGE =
  'OpenCode could not verify provider anthropic with 3 model candidates: ' +
  'anthropic/claude-sonnet-4-5: Not Found; anthropic/claude-haiku-4-5: Not Found; ' +
  'anthropic/claude-opus-4-1: Not Found';

function createFailureResponse(
  error: Partial<RuntimeProviderManagementErrorDto>
): RuntimeProviderManagementProviderResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    error: {
      code: 'auth-failed',
      message: 'Runtime provider management command failed',
      recoverable: true,
      diagnostics: null,
      ...error,
    },
  };
}

describe('isOpenCodeProviderVerifyFailure', () => {
  it('matches the live orchestrator model-candidate probe failure message', () => {
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({ message: LIVE_VERIFY_FAILURE_MESSAGE })
      )
    ).toBe(true);
  });

  it('matches rephrased probe failures and contracted wording', () => {
    for (const message of [
      "OpenCode couldn't verify provider anthropic",
      'The runtime was unable to verify the provider with any model candidate',
      'Failed to verify provider anthropic: Not Found',
    ]) {
      expect(isOpenCodeProviderVerifyFailure(createFailureResponse({ message }))).toBe(true);
    }
  });

  it('matches the signature across line breaks and inside diagnostics previews with ANSI codes', () => {
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({ message: 'OpenCode could not\n  verify provider anthropic' })
      )
    ).toBe(true);
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({
          message: 'Runtime provider management command failed',
          diagnostics: {
            summary: null,
            likelyCause: null,
            binaryPath: null,
            command: null,
            projectPath: null,
            exitCode: 1,
            stderrPreview:
              '\u001b[31mOpenCode could not verify provider anthropic\u001b[0m with 3 model candidates',
            stdoutPreview: null,
            hints: [],
          },
        })
      )
    ).toBe(true);
  });

  it('ignores unrelated auth failures and non-error responses', () => {
    expect(
      isOpenCodeProviderVerifyFailure(createFailureResponse({ message: 'Invalid API key' }))
    ).toBe(false);
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({ message: 'Not logged in to provider anthropic' })
      )
    ).toBe(false);
    expect(
      isOpenCodeProviderVerifyFailure({ schemaVersion: 1, runtimeId: 'opencode' })
    ).toBe(false);
  });

  it('refuses failures that carry credential-rejection evidence even with the verify-provider core', () => {
    for (const message of [
      'Failed to verify provider: invalid API key',
      'OpenCode could not verify provider anthropic: the API key is invalid',
      'Unable to verify provider anthropic with 3 model candidates: ' +
        'anthropic/claude-sonnet-4-5: 401 authentication_error: invalid x-api-key',
      'OpenCode could not verify provider anthropic with 1 model candidate: ' +
        'anthropic/claude-opus-4-1: 403 Forbidden',
      'Could not verify provider openrouter: invalid credentials',
      'Cannot verify provider anthropic: Unauthorized',
      'Failed to verify provider anthropic: permission denied',
      'Could not verify provider anthropic: not_authenticated',
    ]) {
      expect(isOpenCodeProviderVerifyFailure(createFailureResponse({ message }))).toBe(false);
    }
  });

  it('refuses when rejection evidence sits in a diagnostics field beside a matching message', () => {
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({
          message: LIVE_VERIFY_FAILURE_MESSAGE,
          diagnostics: {
            summary: null,
            likelyCause: null,
            binaryPath: null,
            command: null,
            projectPath: null,
            exitCode: 1,
            stderrPreview: '[31m401 invalid x-api-key[0m',
            stdoutPreview: null,
            hints: [],
          },
        })
      )
    ).toBe(false);
  });

  it('keeps matching probe failures whose model ids and reasons only look numeric', () => {
    expect(
      isOpenCodeProviderVerifyFailure(
        createFailureResponse({
          message:
            'OpenCode could not verify provider anthropic with 2 model candidates: ' +
            'anthropic/claude-opus-4-1: Not Found; anthropic/claude-4-0403-preview: Not Found',
        })
      )
    ).toBe(true);
  });

  it('never matches a response that already carries a connected provider', () => {
    const response = createFailureResponse({ message: LIVE_VERIFY_FAILURE_MESSAGE });
    expect(
      isOpenCodeProviderVerifyFailure({
        ...response,
        provider: {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          state: 'connected',
          ownership: ['managed'],
          recommended: true,
          modelCount: 3,
          defaultModelId: null,
          authMethods: ['api'],
          actions: [],
          detail: null,
        },
      })
    ).toBe(false);
  });
});
