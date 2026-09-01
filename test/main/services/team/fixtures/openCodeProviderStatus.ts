import type { CliProviderStatus } from '@shared/types';

export function openCodeProviderStatus(models: string[]): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'provider',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models: [],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      staleAt: new Date(Date.now() + 60_000).toISOString(),
      defaultModelId: null,
      defaultLaunchModel: null,
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: models.map((model) => ({
        id: model,
        launchModel: model,
        displayName: model,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      })),
    },
  };
}
