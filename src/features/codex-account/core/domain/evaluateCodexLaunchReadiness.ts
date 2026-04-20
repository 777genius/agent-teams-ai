import type {
  CodexAccountAppServerState,
  CodexAccountAuthMode,
  CodexAccountEffectiveAuthMode,
  CodexApiKeyAvailabilityDto,
  CodexLaunchReadinessState,
  CodexManagedAccountDto,
} from '@features/codex-account/contracts';

export interface CodexLaunchReadinessResult {
  state: CodexLaunchReadinessState;
  effectiveAuthMode: CodexAccountEffectiveAuthMode;
  launchAllowed: boolean;
  issueMessage: string | null;
}

export function evaluateCodexLaunchReadiness(input: {
  preferredAuthMode: CodexAccountAuthMode;
  managedAccount: CodexManagedAccountDto | null;
  apiKey: CodexApiKeyAvailabilityDto;
  appServerState: CodexAccountAppServerState;
  appServerStatusMessage: string | null;
  localActiveChatgptAccountPresent?: boolean;
}): CodexLaunchReadinessResult {
  const managedAccountAvailable = input.managedAccount?.type === 'chatgpt';
  const apiKeyAvailable = input.apiKey.available;

  if (input.appServerState === 'runtime-missing') {
    return {
      state: 'runtime_missing',
      effectiveAuthMode: null,
      launchAllowed: false,
      issueMessage:
        input.appServerStatusMessage ?? 'Codex CLI is not available, so native Codex cannot start.',
    };
  }

  if (input.preferredAuthMode === 'chatgpt') {
    if (managedAccountAvailable) {
      return {
        state:
          input.appServerState === 'degraded' ? 'warning_degraded_but_launchable' : 'ready_chatgpt',
        effectiveAuthMode: 'chatgpt',
        launchAllowed: true,
        issueMessage:
          input.appServerState === 'degraded'
            ? (input.appServerStatusMessage ??
              'ChatGPT account detected, but account verification is currently degraded.')
            : null,
      };
    }

    return {
      state: input.appServerState === 'incompatible' ? 'incompatible' : 'missing_auth',
      effectiveAuthMode: null,
      launchAllowed: false,
      issueMessage:
        input.appServerState === 'incompatible'
          ? (input.appServerStatusMessage ??
            'This Codex installation does not support ChatGPT account management.')
          : input.localActiveChatgptAccountPresent
            ? 'Reconnect ChatGPT to refresh the current Codex subscription session.'
            : 'Connect a ChatGPT account to use your Codex subscription.',
    };
  }

  if (input.preferredAuthMode === 'api_key') {
    if (apiKeyAvailable) {
      return {
        state: 'ready_api_key',
        effectiveAuthMode: 'api_key',
        launchAllowed: true,
        issueMessage: null,
      };
    }

    return {
      state: 'missing_auth',
      effectiveAuthMode: null,
      launchAllowed: false,
      issueMessage: 'Add OPENAI_API_KEY or CODEX_API_KEY to use Codex API key mode.',
    };
  }

  if (managedAccountAvailable) {
    return {
      state:
        input.appServerState === 'degraded'
          ? 'warning_degraded_but_launchable'
          : apiKeyAvailable
            ? 'ready_both'
            : 'ready_chatgpt',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      issueMessage:
        input.appServerState === 'degraded'
          ? (input.appServerStatusMessage ??
            'ChatGPT account detected, but account verification is currently degraded.')
          : null,
    };
  }

  if (apiKeyAvailable) {
    return {
      state: 'ready_api_key',
      effectiveAuthMode: 'api_key',
      launchAllowed: true,
      issueMessage: null,
    };
  }

  return {
    state: input.appServerState === 'incompatible' ? 'incompatible' : 'missing_auth',
    effectiveAuthMode: null,
    launchAllowed: false,
    issueMessage:
      input.appServerState === 'incompatible'
        ? (input.appServerStatusMessage ??
          'This Codex installation does not support ChatGPT account management.')
        : input.localActiveChatgptAccountPresent
          ? 'Reconnect ChatGPT to refresh the current Codex subscription session, or add OPENAI_API_KEY / CODEX_API_KEY to use Codex.'
          : 'Connect a ChatGPT account or add OPENAI_API_KEY / CODEX_API_KEY to use Codex.',
  };
}
