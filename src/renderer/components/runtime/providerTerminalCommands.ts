import type { CliProviderStatus } from '@shared/types';

export interface ProviderTerminalCommand {
  args: string[];
  env?: Record<string, string>;
}

export function getProviderTerminalCommand(provider: CliProviderStatus): ProviderTerminalCommand {
  if (provider.providerId === 'gemini') {
    return {
      args: ['login'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  if (provider.providerId === 'codex') {
    return {
      args: ['auth', 'login', '--provider', provider.providerId],
      env: {
        CLAUDE_CODE_CODEX_BACKEND: provider.selectedBackendId ?? 'codex-native',
      },
    };
  }

  return {
    args: ['auth', 'login', '--provider', provider.providerId],
  };
}

export function getProviderTerminalLogoutCommand(
  provider: CliProviderStatus
): ProviderTerminalCommand {
  if (provider.providerId === 'gemini') {
    return {
      args: ['logout'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  if (provider.providerId === 'codex') {
    return {
      args: ['auth', 'logout', '--provider', provider.providerId],
      env: {
        CLAUDE_CODE_CODEX_BACKEND: provider.selectedBackendId ?? 'codex-native',
      },
    };
  }

  return {
    args: ['auth', 'logout', '--provider', provider.providerId],
  };
}
