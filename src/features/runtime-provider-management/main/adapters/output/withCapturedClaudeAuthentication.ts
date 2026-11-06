import { randomUUID } from 'node:crypto';

import {
  type CapturedClaudeAuthentication,
  readCapturedClaudeAuthentication,
} from './capturedClaudeAuthentication';
import { managementValue } from './capturedManagementCatalog';

import type * as Dto from '../../../contracts';
import type {
  RuntimeProviderManagementPort,
  RuntimeProviderManagementRequestScope,
} from '../../../core/application';
import type { CapturedProviderOAuth } from './CapturedProviderOAuth';
import type { CapturedRuntimeProviderManagementDependencies } from './CapturedRuntimeProviderManagementClient';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

const unavailable = () => ({
  schemaVersion: 1 as const,
  runtimeId: 'claude' as const,
  error: {
    code: 'runtime-unhealthy' as const,
    message:
      'Unable to confirm the original Claude sign-in. Refresh its status before another action.',
    recoverable: true,
  },
});
const unsupported = async () => ({
  schemaVersion: 1 as const,
  runtimeId: 'claude' as const,
  error: {
    code: 'unsupported-action' as const,
    message: 'Use the existing connection settings for this action.',
    recoverable: true,
  },
});
type AuthStatus = CapturedClaudeAuthentication;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Claude auth state unavailable');
  return value as Record<string, unknown>;
};

/** Auth-only Claude successor. Existing model discovery/defaults and app-owned API keys retain their owners. */
export function withCapturedClaudeAuthentication(
  original: RuntimeProviderManagementPort,
  capture: CapturedRuntimeProviderManagementDependencies['capture'] | undefined,
  oauth: CapturedProviderOAuth | undefined
): RuntimeProviderManagementPort {
  const forms = new Map<
    string,
    {
      target: CapturedProviderManagement;
      projectPath: string | null;
      expiresAt: number;
    }
  >();
  const assertScope = (scope?: RuntimeProviderManagementRequestScope) => {
    if (scope && !scope.isCurrent()) throw new Error('Original Claude account sender changed');
  };
  const target = async (
    input: {
      runtimeId: string;
      providerId?: string;
      projectPath?: string | null;
      connectionContextToken?: string;
    },
    scope?: RuntimeProviderManagementRequestScope
  ) => {
    assertScope(scope);
    if (
      !capture ||
      input.runtimeId !== 'claude' ||
      (input.providerId !== undefined && input.providerId !== 'anthropic')
    )
      throw new Error('Claude auth target unavailable');
    for (const [token, form] of forms)
      if (!form.target.isCurrent() || form.expiresAt <= Date.now()) forms.delete(token);
    if (input.connectionContextToken !== undefined) {
      const form = forms.get(input.connectionContextToken);
      if (!form || form.projectPath !== (input.projectPath ?? null))
        throw new Error('Original Claude account selection is unavailable');
      return form.target;
    }
    const selected = await capture(input.projectPath ?? null, scope?.isCurrent);
    assertScope(scope);
    return selected;
  };
  const read = async (
    selected: CapturedProviderManagement,
    scope?: RuntimeProviderManagementRequestScope
  ) => {
    assertScope(scope);
    const status = await readCapturedClaudeAuthentication(selected);
    assertScope(scope);
    return status;
  };
  const provider = (status: AuthStatus): Dto.RuntimeProviderConnectionDto => ({
    providerId: 'anthropic',
    displayName: 'Claude',
    state: status.loggedIn ? 'connected' : 'not-connected',
    ownership: ['local'],
    recommended: false,
    modelCount: 0,
    defaultModelId: null,
    authMethods: ['oauth'],
    detail: status.loggedIn
      ? 'Native Claude sign-in is available.'
      : 'Sign in with your Claude subscription.',
    actions: [
      {
        id: status.loggedIn ? 'reconnect' : 'connect',
        label: status.loggedIn ? 'Reconnect' : 'Sign in',
        enabled: status.canLogin,
        disabledReason: status.canLogin
          ? null
          : 'This account is managed by the existing connection settings.',
        requiresSecret: false,
        ownershipScope: 'local',
      },
      {
        id: 'forget',
        label: 'Sign out',
        enabled: status.canLogout && status.loggedIn,
        disabledReason: status.canLogout
          ? null
          : 'This account is managed by the existing connection settings.',
        requiresSecret: false,
        ownershipScope: 'local',
      },
    ],
  });
  const connection = async (
    selected: CapturedProviderManagement,
    scope?: RuntimeProviderManagementRequestScope
  ): Promise<Dto.RuntimeProviderManagementProviderResponse> => ({
    schemaVersion: 1,
    runtimeId: 'claude',
    provider: provider(await read(selected, scope)),
  });
  return {
    ...original,
    async loadView(input, scope) {
      if (input.runtimeId !== 'claude') return original.loadView(input);
      const captured = { ...input };
      try {
        const status = await read(await target(captured, scope), scope);
        return {
          schemaVersion: 1,
          runtimeId: 'claude',
          view: {
            runtimeId: 'claude',
            title: 'Claude account',
            runtime: {
              state: status.loggedIn ? 'ready' : 'needs-auth',
              cliPath: null,
              version: null,
              managedProfile: 'active',
              localAuth: status.loggedIn ? 'synced' : 'missing',
            },
            providers: [provider(status)],
            defaultModel: null,
            fallbackModel: null,
            diagnostics: [],
          },
        };
      } catch {
        return unavailable();
      }
    },
    async loadProviderDirectory(input, scope) {
      if (input.runtimeId !== 'claude') return original.loadProviderDirectory(input);
      const captured = { ...input };
      try {
        const status = await read(await target(captured, scope), scope);
        const entry: Dto.RuntimeProviderDirectoryEntryDto = {
          ...provider(status),
          modelCount: null,
          setupKind: status.loggedIn ? 'connected' : 'connect-oauth',
          sources: ['inventory'],
          sourceLabel: 'Claude account',
          providerSource: 'native',
          metadata: {
            hasKnownModels: false,
            requiresManualConfig: false,
            supportedInlineAuth: status.canLogin,
            configuredAuthless: false,
          },
        };
        const entries =
          !captured.query || 'claude anthropic'.includes(captured.query.trim().toLowerCase())
            ? [entry]
            : [];
        return {
          schemaVersion: 1,
          runtimeId: 'claude',
          directory: {
            runtimeId: 'claude',
            totalCount: entries.length,
            returnedCount: entries.length,
            query: captured.query ?? null,
            filter: captured.filter ?? 'all',
            limit: 1,
            cursor: null,
            nextCursor: null,
            entries,
            diagnostics: [],
            fetchedAt: new Date().toISOString(),
          },
        };
      } catch {
        return unavailable();
      }
    },
    async loadSetupForm(input, scope) {
      if (input.runtimeId !== 'claude') return original.loadSetupForm(input);
      const captured = { ...input };
      try {
        const selected = await target(captured, scope);
        const status = await read(selected, scope);
        if (!captured.connectionContextToken && forms.size >= 64)
          throw new Error('Too many original Claude sign-in forms');
        const connectionContextToken = captured.connectionContextToken ?? randomUUID();
        if (!captured.connectionContextToken)
          forms.set(connectionContextToken, {
            target: selected,
            projectPath: captured.projectPath ?? null,
            expiresAt: Date.now() + 17 * 60_000,
          });
        const supported = status.canLogin && !!oauth;
        const disabledReason = supported
          ? null
          : 'This account is managed by the existing connection settings.';
        return {
          schemaVersion: 1,
          runtimeId: 'claude',
          setupForm: {
            connectionContextToken,
            runtimeId: 'claude',
            providerId: 'anthropic',
            displayName: 'Claude',
            method: 'oauth',
            supported,
            title: 'Sign in to Claude',
            description: null,
            submitLabel: 'Sign in with browser',
            disabledReason,
            source: 'oauth',
            secret: null,
            prompts: [],
            authOptions: [
              {
                id: 'oauth:0',
                method: 'oauth',
                methodIndex: 0,
                label: 'Claude subscription',
                supported,
                disabledReason,
                secret: null,
                prompts: [],
              },
            ],
            defaultAuthOptionId: 'oauth:0',
            verification: null,
          },
        };
      } catch {
        return unavailable();
      }
    },
    async connectProvider(input, scope) {
      if (input.runtimeId !== 'claude') return original.connectProvider(input);
      const captured = {
        ...input,
        metadata: input.metadata ? { ...input.metadata } : input.metadata,
      };
      if (
        captured.providerId !== 'anthropic' ||
        captured.method !== 'oauth' ||
        captured.authMethodIndex !== 0 ||
        (captured.authOptionId != null && captured.authOptionId !== 'oauth:0') ||
        captured.apiKey ||
        (captured.metadata && Object.keys(captured.metadata).length) ||
        !captured.oauthOperationId ||
        !oauth
      )
        return unsupported();
      try {
        if (!captured.connectionContextToken)
          throw new Error('Original Claude sign-in form is unavailable');
        const selected = await target(captured, scope);
        if (!(await read(selected, scope)).canLogin) return unsupported();
        await oauth.connect(selected, {
          runtimeId: 'claude',
          operationId: captured.oauthOperationId,
          providerId: 'anthropic',
          methodIndex: 0,
          authOptionId: 'oauth:0',
          displayName: 'Claude',
        });
        return await connection(selected, scope);
      } catch {
        return unavailable();
      }
    },
    async forgetCredential(input, scope) {
      if (input.runtimeId !== 'claude') return original.forgetCredential(input);
      const captured = { ...input },
        commandId = randomUUID();
      try {
        if (!captured.connectionContextToken)
          throw new Error('Original Claude sign-out selection is unavailable');
        const selected = await target(captured, scope);
        if (!(await read(selected, scope)).canLogout) return unsupported();
        const value = object(
          managementValue(
            await selected.request('credential', {
              commandId,
              providerId: 'anthropic',
              kind: 'credential.forget',
            })
          )
        );
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.commandId !== commandId ||
          value.profileId !== selected.profileId ||
          value.configRevision !== selected.configRevision ||
          value.providerId !== 'anthropic' ||
          value.kind !== 'credential.forget' ||
          value.phase !== 'completed'
        )
          throw new Error('Claude sign-out outcome unknown');
        return await connection(selected, scope);
      } catch {
        return unavailable();
      }
    },
    connectWithApiKey: (input) =>
      input.runtimeId === 'claude' ? unsupported() : original.connectWithApiKey(input),
    loadModels: (input) =>
      input.runtimeId === 'claude' ? unsupported() : original.loadModels(input),
    setDefaultModel: (input) =>
      input.runtimeId === 'claude' ? unsupported() : original.setDefaultModel(input),
    clearProjectDefaultModel: (input) =>
      input.runtimeId === 'claude' ? unsupported() : original.clearProjectDefaultModel(input),
    configureModelLimits: (input) =>
      input.runtimeId === 'claude' ? unsupported() : original.configureModelLimits(input),
  };
}
