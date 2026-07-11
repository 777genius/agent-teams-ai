import type { CliProviderId, CliProviderStatus } from '@shared/types';

export interface ProviderTerminalCommand {
  args: string[];
  env?: Record<string, string>;
}

export function getProviderTerminalCommandById(
  providerId: CliProviderId,
  action: 'login' | 'logout'
): ProviderTerminalCommand {
  return {
    args: ['auth', action, '--provider', providerId],
  };
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

  return getProviderTerminalCommandById(provider.providerId, 'login');
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

  return getProviderTerminalCommandById(provider.providerId, 'logout');
}
