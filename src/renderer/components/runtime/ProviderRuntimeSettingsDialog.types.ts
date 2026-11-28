import type { NativeClaudeAuthenticationAction } from './useProviderAuthenticationActions';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { AnalyticsProviderCheckReason } from '@renderer/analytics/productAnalytics';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

export type ApiKeyProviderId = 'anthropic' | 'codex' | 'gemini';
export type PendingConnectionAction =
  | 'auto'
  | 'oauth'
  | 'chatgpt'
  | 'api_key'
  | 'compatible'
  | 'codex-custom-provider'
  | null;

export interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: CliProviderStatus[];
  readonly initialProviderId: CliProviderId;
  readonly initialRuntimeProviderId?: string | null;
  readonly initialRuntimeProviderAction?: 'connect' | 'reconnect' | 'select' | null;
  readonly projectPath?: string | null;
  readonly providerStatusLoading?: Partial<Record<CliProviderId, boolean>>;
  readonly disabled?: boolean;
  readonly codexRuntimeStatus?: CodexRuntimeStatus | null;
  readonly codexRuntimeStatusLoading?: boolean;
  readonly onInstallCodexRuntime?: () => Promise<void> | void;
  readonly onSelectBackend: (providerId: CliProviderId, backendId: string) => Promise<void> | void;
  readonly onRefreshProvider?: (
    providerId: CliProviderId,
    checkReason?: AnalyticsProviderCheckReason
  ) => Promise<boolean | void> | boolean | void;
  readonly onRequestLogin?: (providerId: CliProviderId) => void;
  readonly nativeClaudeAuthAction?: NativeClaudeAuthenticationAction | null;
}
