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
