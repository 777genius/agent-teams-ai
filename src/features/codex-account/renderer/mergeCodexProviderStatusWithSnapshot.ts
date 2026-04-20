import type { CodexAccountSnapshotDto } from '../contracts';
import type { CliProviderStatus } from '@shared/types';

const CODEX_NATIVE_BACKEND_ID = 'codex-native';
const CODEX_NATIVE_LABEL = 'Codex native';
const CODEX_NATIVE_DESCRIPTION = 'Use codex exec JSON mode.';
const DEFAULT_CODEX_AUTH_MODES = ['auto', 'chatgpt', 'api_key'] as const;

function isCodexBootstrapPlaceholder(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'codex' &&
    provider.supported === false &&
    provider.statusMessage === 'Checking...' &&
    provider.models.length === 0 &&
    provider.backend == null
  );
}

function getCodexNativeBackendTruth(
  snapshot: CodexAccountSnapshotDto
): Pick<
  NonNullable<CliProviderStatus['availableBackends']>[number],
  'available' | 'selectable' | 'state' | 'statusMessage' | 'detailMessage'
> {
  switch (snapshot.launchReadinessState) {
    case 'ready_chatgpt':
    case 'ready_api_key':
    case 'ready_both':
      return {
        available: true,
        selectable: true,
        state: snapshot.appServerState === 'degraded' ? 'degraded' : 'ready',
        statusMessage:
          snapshot.appServerState === 'degraded'
            ? (snapshot.launchIssueMessage ??
              snapshot.appServerStatusMessage ??
              'Ready with degraded account verification.')
            : 'Ready',
        detailMessage: snapshot.appServerStatusMessage,
      };
    case 'warning_degraded_but_launchable':
      return {
        available: true,
        selectable: true,
        state: 'degraded',
        statusMessage:
          snapshot.launchIssueMessage ??
          snapshot.appServerStatusMessage ??
          'Ready with degraded account verification.',
        detailMessage: snapshot.appServerStatusMessage,
      };
    case 'runtime_missing':
      return {
        available: false,
        selectable: false,
        state: 'runtime-missing',
        statusMessage:
          snapshot.launchIssueMessage ?? snapshot.appServerStatusMessage ?? 'Runtime missing',
        detailMessage: snapshot.appServerStatusMessage,
      };
    case 'incompatible':
      return {
        available: false,
        selectable: false,
        state: 'disabled',
        statusMessage:
          snapshot.launchIssueMessage ?? snapshot.appServerStatusMessage ?? 'Runtime incompatible',
        detailMessage: snapshot.appServerStatusMessage,
      };
    case 'missing_auth':
    default:
      return {
        available: false,
        selectable: true,
        state: 'authentication-required',
        statusMessage:
          snapshot.launchIssueMessage ??
          'Connect a ChatGPT account or add OPENAI_API_KEY / CODEX_API_KEY to use Codex.',
        detailMessage: snapshot.appServerStatusMessage,
      };
  }
}

function getProviderStatusMessage(
  snapshot: CodexAccountSnapshotDto,
  fallback: string | null | undefined
): string | null {
  if (snapshot.launchAllowed) {
    if (snapshot.effectiveAuthMode === 'chatgpt') {
      return snapshot.appServerState === 'degraded'
        ? (snapshot.launchIssueMessage ??
            'ChatGPT account detected - account verification is currently degraded.')
        : 'ChatGPT account ready';
    }

    if (snapshot.effectiveAuthMode === 'api_key') {
      return 'API key ready';
    }
  }

  return snapshot.launchIssueMessage ?? snapshot.appServerStatusMessage ?? fallback ?? null;
}

function mergeCodexNativeBackendOption(
  provider: CliProviderStatus,
  snapshot: CodexAccountSnapshotDto
): NonNullable<CliProviderStatus['availableBackends']> {
  const truth = getCodexNativeBackendTruth(snapshot);
  const existingOptions = provider.availableBackends ?? [];
  const hasCodexNativeOption = existingOptions.some(
    (option) => option.id === CODEX_NATIVE_BACKEND_ID
  );
  const baseOptions = hasCodexNativeOption
    ? existingOptions
    : [
        ...existingOptions,
        {
          id: CODEX_NATIVE_BACKEND_ID,
          label: CODEX_NATIVE_LABEL,
          description: CODEX_NATIVE_DESCRIPTION,
          selectable: true,
          recommended: true,
          available: true,
          state: 'ready' as const,
          audience: 'general' as const,
          statusMessage: null,
          detailMessage: null,
        },
      ];

  return baseOptions.map((option) => {
    if (option.id !== CODEX_NATIVE_BACKEND_ID) {
      return option;
    }

    return {
      ...option,
      label: option.label || CODEX_NATIVE_LABEL,
      description: option.description || CODEX_NATIVE_DESCRIPTION,
      recommended: option.recommended !== false,
      audience: option.audience ?? 'general',
      ...truth,
    };
  });
}

export function mergeCodexProviderStatusWithSnapshot(
  provider: CliProviderStatus,
  snapshot: CodexAccountSnapshotDto | null
): CliProviderStatus {
  if (provider.providerId !== 'codex' || !snapshot) {
    return provider;
  }

  const availableBackends = mergeCodexNativeBackendOption(provider, snapshot);
  const baseConnection = provider.connection ?? {
    supportsOAuth: false,
    supportsApiKey: true,
    configurableAuthModes: [...DEFAULT_CODEX_AUTH_MODES],
    configuredAuthMode: snapshot.preferredAuthMode,
    apiKeyConfigured: snapshot.apiKey.available,
    apiKeySource: snapshot.apiKey.source,
    apiKeySourceLabel: snapshot.apiKey.sourceLabel,
    codex: null,
  };

  return {
    ...provider,
    supported: provider.supported || isCodexBootstrapPlaceholder(provider),
    authenticated: snapshot.launchAllowed,
    authMethod:
      snapshot.effectiveAuthMode === 'chatgpt'
        ? 'chatgpt'
        : snapshot.effectiveAuthMode === 'api_key'
          ? 'api_key'
          : null,
    verificationState: snapshot.launchAllowed
      ? 'verified'
      : snapshot.appServerState === 'runtime-missing' || snapshot.appServerState === 'incompatible'
        ? 'error'
        : 'unknown',
    statusMessage: getProviderStatusMessage(snapshot, provider.statusMessage),
    selectedBackendId: CODEX_NATIVE_BACKEND_ID,
    resolvedBackendId: CODEX_NATIVE_BACKEND_ID,
    availableBackends,
    backend: {
      kind: CODEX_NATIVE_BACKEND_ID,
      label: CODEX_NATIVE_LABEL,
      endpointLabel: 'codex exec --json',
      projectId: provider.backend?.projectId ?? null,
      authMethodDetail: snapshot.effectiveAuthMode ?? null,
    },
    connection: {
      ...baseConnection,
      configuredAuthMode: snapshot.preferredAuthMode,
      apiKeyConfigured: snapshot.apiKey.available,
      apiKeySource: snapshot.apiKey.source,
      apiKeySourceLabel: snapshot.apiKey.sourceLabel,
      codex: {
        preferredAuthMode: snapshot.preferredAuthMode,
        effectiveAuthMode: snapshot.effectiveAuthMode,
        launchAllowed: snapshot.launchAllowed,
        launchIssueMessage: snapshot.launchIssueMessage,
        launchReadinessState: snapshot.launchReadinessState,
        appServerState: snapshot.appServerState,
        appServerStatusMessage: snapshot.appServerStatusMessage,
        managedAccount: snapshot.managedAccount,
        requiresOpenaiAuth: snapshot.requiresOpenaiAuth,
        localAccountArtifactsPresent: snapshot.localAccountArtifactsPresent,
        localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
        login: snapshot.login,
        rateLimits: snapshot.rateLimits,
      },
    },
  };
}
