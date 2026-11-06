import { randomUUID } from 'node:crypto';

import { validManagedModelLimits } from '../../../core/domain/managedProviderPreferences';

import {
  connection,
  directoryEntry,
  managementValue,
  models,
  parseManagementCatalog,
} from './capturedManagementCatalog';
import {
  nativeDefaultModel,
  preferenceModelRows,
  selectedPreferences,
} from './capturedManagementPreferences';
import { CapturedModelProbe } from './CapturedModelProbe';
import { CapturedProviderOAuth } from './CapturedProviderOAuth';
import { withCapturedClaudeAuthentication } from './withCapturedClaudeAuthentication';

import type * as Dto from '../../../contracts';
import type { RuntimeProviderManagementPort } from '../../../core/application';
import type { CatalogProvider } from './capturedManagementCatalog';
import type { CapturedProviderOAuthDependencies } from './CapturedProviderOAuth';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

export interface CapturedRuntimeProviderManagementDependencies {
  /** Shell captures the active service context before awaiting backend initialization. */
  capture(
    projectPath: string | null,
    isCurrent?: () => boolean
  ): Promise<CapturedProviderManagement>;
  oauth?: CapturedProviderOAuthDependencies;
  captureClaude?: CapturedRuntimeProviderManagementDependencies['capture'];
}

const unavailable = () => ({
  schemaVersion: 1 as const,
  runtimeId: 'opencode' as const,
  error: {
    code: 'runtime-unhealthy' as const,
    message:
      'Unable to confirm provider state. Refresh provider settings before repeating this action.',
    recoverable: true,
  },
});
const unsupported = async () => ({
  schemaVersion: 1 as const,
  runtimeId: 'opencode' as const,
  error: {
    code: 'unsupported-action' as const,
    message: 'This provider action is currently unavailable.',
    recoverable: true,
  },
});

function page<T>(
  rows: T[],
  input: { query?: string | null; limit?: number | null; cursor?: string | null },
  label: (row: T) => string
) {
  const query = input.query?.trim().toLowerCase() ?? '';
  const limit = input.limit ?? 100;
  const offset = input.cursor ? Number(input.cursor) : 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.cursor && String(offset) !== input.cursor)
  )
    throw new Error('Invalid management page');
  const matched = rows.filter((entry) => label(entry).toLowerCase().includes(query));
  return {
    entries: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    next: offset + limit < matched.length ? String(offset + limit) : null,
  };
}

/** Existing UI port over a captured Host. Selected-backend failures never invoke the fork. */
export function createCapturedRuntimeProviderManagementClient(
  deps: CapturedRuntimeProviderManagementDependencies
): RuntimeProviderManagementPort {
  const oauth = deps.oauth ? new CapturedProviderOAuth(deps.oauth) : undefined;
  const createProbe = (selectedCapture: CapturedRuntimeProviderManagementDependencies['capture']) =>
    new CapturedModelProbe(
      selectedCapture,
      async (target, input) => {
        const selected = await selectedPreferences(target, null);
        const limits = selected.resolved.modelLimitOverrides[input.modelId];
        return limits
          ? { contextTokens: limits.contextTokens, outputTokens: limits.outputTokens }
          : undefined;
      },
      deps.captureClaude
    );
  const probes = createProbe(deps.capture);
  const capture = (input: Dto.RuntimeProviderManagementLoadViewInput) => {
    if (input?.runtimeId !== 'opencode') throw new Error('Unsupported runtime');
    return deps.capture(input.projectPath ?? null);
  };
  const catalog = async (target: CapturedProviderManagement, providerId?: string) =>
    parseManagementCatalog(
      await target.request('catalog', providerId === undefined ? {} : { providerId }),
      target
    );
  const selected = (providers: CatalogProvider[], providerId: string) => {
    const provider = providers.find((entry) => entry.providerId === providerId);
    if (!provider) throw new Error('Provider unavailable');
    return provider;
  };
  const readCatalog = async (target: CapturedProviderManagement) => {
    const raw = await target.request('catalog', {});
    return {
      providers: parseManagementCatalog(raw, target),
      nativeDefault: nativeDefaultModel(raw),
    };
  };
  const view = async (
    target: CapturedProviderManagement,
    projectPath: string | null,
    previous?: Awaited<ReturnType<typeof readCatalog>>
  ): Promise<Dto.RuntimeProviderManagementViewResponse> => {
    let current: Awaited<ReturnType<typeof readCatalog>>;
    let degraded = false;
    try {
      current = await readCatalog(target);
    } catch (error) {
      if (!previous || !target.isCurrent()) throw error;
      current = previous;
      degraded = true;
    }
    const preferences = await selectedPreferences(target, current.nativeDefault);
    const resolved = preferences.resolved;
    if (!target.isCurrent()) throw new Error('Provider preferences context changed');
    return {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode providers',
        runtime: {
          state: degraded ? 'degraded' : 'ready',
          cliPath: null,
          version: null,
          managedProfile: 'active',
          localAuth: 'disabled',
        },
        providers: current.providers.map((provider) => ({
          ...connection(provider),
          defaultModelId: resolved.defaultModel?.startsWith(provider.providerId + '/')
            ? resolved.defaultModel
            : null,
        })),
        projectPath,
        defaultModel: resolved.defaultModel,
        fallbackModel: resolved.fallbackModel,
        ...(preferences.store
          ? {
              projectDefaultModel: resolved.projectDefaultModel,
              allProjectsDefaultModel: resolved.allProjectsDefaultModel,
              defaultModelSource: resolved.defaultModelSource,
            }
          : {}),
        diagnostics: degraded
          ? [
              'Model preferences were saved, but provider status could not be refreshed. Refresh before launching.',
            ]
          : preferences.store
            ? []
            : ['Saved model preferences are unavailable for this scope.'],
      },
    };
  };
  const modelLoads = new Map<string, Set<AbortController>>();
  const credential = async (
    input: Dto.RuntimeProviderManagementForgetInput,
    key?: string,
    metadata?: Record<string, string> | null
  ): Promise<Dto.RuntimeProviderManagementProviderResponse> => {
    // Copy before any await: caller mutation must not change an already captured intent.
    const captured = { ...input },
      commandId = randomUUID();
    const capturedMetadata = metadata ? { ...metadata } : undefined;
    try {
      if (
        !captured.providerId ||
        captured.providerId.length > 256 ||
        (key !== undefined && (!key.trim() || key.length > 8192 || /[\0\r\n]/.test(key)))
      )
        throw new Error('Invalid credential');
      const target = await capture(captured);
      const result = managementValue(
        await target.request('credential', {
          commandId,
          kind: key === undefined ? 'credential.forget' : 'credential.set',
          providerId: captured.providerId,
          ...(key === undefined ? {} : { key }),
          ...(capturedMetadata ? { metadata: capturedMetadata } : {}),
        })
      );
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        !('phase' in result) ||
        result.phase !== 'completed' ||
        !('commandId' in result) ||
        result.commandId !== commandId ||
        !('providerId' in result) ||
        result.providerId !== captured.providerId ||
        !('profileId' in result) ||
        result.profileId !== target.profileId ||
        !('configRevision' in result) ||
        result.configRevision !== target.configRevision ||
        !('kind' in result) ||
        result.kind !== (key === undefined ? 'credential.forget' : 'credential.set')
      )
        throw new Error('Credential outcome unknown');
      // Refresh against the same capture, never a new default/current context.
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: connection(
          selected(await catalog(target, captured.providerId), captured.providerId)
        ),
      };
    } catch {
      return unavailable();
    }
  };
  const port: RuntimeProviderManagementPort = {
    async loadView(input) {
      const captured = { ...input };
      try {
        return await view(await capture(captured), captured.projectPath ?? null);
      } catch {
        return unavailable();
      }
    },
    async loadProviderDirectory(input) {
      const captured = { ...input };
      try {
        const target = await capture(captured),
          providers = await catalog(target);
        const filter = captured.filter ?? 'all';
        if (
          !['all', 'connected', 'configured', 'connectable', 'manual', 'has-models'].includes(
            filter
          )
        )
          throw new Error('Invalid filter');
        const filtered = providers.filter(
          (provider) =>
            filter === 'all' ||
            (filter === 'connected' && provider.connected) ||
            (filter === 'configured' && provider.configured) ||
            (filter === 'connectable' && provider.authMethods.length > 0) ||
            (filter === 'manual' && !provider.authMethods.length) ||
            (filter === 'has-models' && provider.modelCount > 0)
        );
        const result = page(filtered, captured, (row) => `${row.providerId} ${row.displayName}`);
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          directory: {
            runtimeId: 'opencode',
            entries: result.entries.map(directoryEntry),
            totalCount: result.total,
            returnedCount: result.entries.length,
            filter,
            query: captured.query ?? null,
            limit: result.limit,
            cursor: captured.cursor ?? null,
            nextCursor: result.next,
            diagnostics: [],
            fetchedAt: new Date().toISOString(),
          },
        };
      } catch {
        return unavailable();
      }
    },
    async loadModels(input) {
      const captured = { ...input };
      const controller = new AbortController();
      const group = captured.requestGroupId;
      if (group) {
        const entries = modelLoads.get(group) ?? new Set<AbortController>();
        entries.add(controller);
        modelLoads.set(group, entries);
      }
      try {
        const target = await capture(captured);
        controller.signal.throwIfAborted();
        const raw = await target.request('catalog', { providerId: captured.providerId });
        const provider = selected(parseManagementCatalog(raw, target), captured.providerId);
        const preferences = await selectedPreferences(target, nativeDefaultModel(raw));
        controller.signal.throwIfAborted();
        const result = page(
          preferenceModelRows(models(provider), preferences.resolved),
          captured,
          (row) => `${row.modelId} ${row.displayName}`
        );
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          models: {
            runtimeId: 'opencode',
            providerId: provider.providerId,
            models: result.entries,
            defaultModelId: preferences.resolved.defaultModel?.startsWith(provider.providerId + '/')
              ? preferences.resolved.defaultModel
              : null,
            diagnostics: [],
            catalogState: 'fresh',
            totalCount: result.total,
            returnedCount: result.entries.length,
            limit: result.limit,
            cursor: captured.cursor ?? null,
            nextCursor: result.next,
          },
        };
      } catch {
        return unavailable();
      } finally {
        if (group) {
          const entries = modelLoads.get(group);
          entries?.delete(controller);
          if (!entries?.size) modelLoads.delete(group);
        }
      }
    },
    connectWithApiKey: (input) =>
      typeof input?.apiKey === 'string'
        ? credential(input, input.apiKey)
        : Promise.resolve(unavailable()),
    forgetCredential: (input) => credential(input),
    async connectProvider(input) {
      const captured = {
        ...input,
        metadata: input.metadata ? { ...input.metadata } : input.metadata,
      };
      if (captured.method === 'api' && typeof captured.apiKey === 'string')
        return credential(captured, captured.apiKey, captured.metadata);
      if (captured.method !== 'oauth' || !oauth || !captured.oauthOperationId) return unsupported();
      try {
        const target = await capture(captured);
        const provider = selected(await catalog(target, captured.providerId), captured.providerId);
        const option = provider.authOptions?.find(
          (option) => option.methodIndex === captured.authMethodIndex && option.type === 'oauth'
        );
        if (
          !option?.supported ||
          (captured.authOptionId != null && captured.authOptionId !== `oauth:${option.methodIndex}`)
        )
          return unsupported();
        await oauth.connect(target, {
          operationId: captured.oauthOperationId,
          providerId: captured.providerId,
          methodIndex: option.methodIndex,
          authOptionId: captured.authOptionId ?? `oauth:${option.methodIndex}`,
          displayName: provider.displayName,
          ...(captured.metadata ? { fields: captured.metadata } : {}),
        });
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          provider: connection(
            selected(await catalog(target, captured.providerId), captured.providerId)
          ),
        };
      } catch {
        return unavailable();
      }
    },
    async loadSetupForm(input) {
      const captured = { ...input };
      try {
        const target = await capture(captured);
        const provider = selected(await catalog(target, captured.providerId), captured.providerId);
        const options: Dto.RuntimeProviderSetupAuthOptionDto[] = (provider.authOptions ?? []).map(
          (method) => ({
            id: `${method.type}:${method.methodIndex}`,
            method: method.type,
            methodIndex: method.methodIndex,
            label: method.label,
            supported: method.supported && (method.type === 'api' || !!oauth),
            disabledReason:
              method.supported && (method.type === 'api' || oauth)
                ? null
                : 'This sign-in method is unavailable.',
            secret:
              method.type === 'api'
                ? { key: 'key', label: 'API key', placeholder: null, required: true }
                : null,
            prompts: method.prompts.map((prompt) => ({
              ...prompt,
              required: true,
              secret: prompt.type === 'text' && /key|token|password|secret/i.test(prompt.key),
            })),
          })
        );
        const first = options.find((option) => option.supported);
        const api = first
          ? first.method === 'api'
          : provider.authOptions === undefined && provider.authMethods.includes('api');
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          setupForm: {
            runtimeId: 'opencode',
            providerId: provider.providerId,
            displayName: provider.displayName,
            method: first?.method ?? (api ? 'api' : 'manual'),
            supported: !!first || api,
            title: `Connect ${provider.displayName}`,
            description: null,
            submitLabel: first?.method === 'oauth' ? 'Sign in with browser' : 'Save API key',
            disabledReason: first || api ? null : 'Browser sign-in is currently unavailable.',
            source: 'opencode-auth',
            secret: api
              ? { key: 'key', label: 'API key', placeholder: null, required: true }
              : null,
            prompts: first?.prompts ?? [],
            authOptions: options,
            defaultAuthOptionId: first?.id ?? null,
            verification: null,
          },
        };
      } catch {
        return unavailable();
      }
    },
    testModel: (input) => probes.test(input),
    async setDefaultModel(input) {
      const captured = { ...input };
      const scope = captured.scope ?? 'project';
      if (
        !['project', 'all_projects'].includes(scope) ||
        (scope === 'project' && !captured.projectPath)
      )
        return unsupported();
      const projectPath = scope === 'all_projects' ? null : captured.projectPath!;
      try {
        const target = await capture({ ...captured, projectPath });
        if (!target.preferences || (scope === 'project' && !target.preferences.projectRoot))
          return unsupported();
        const preferences = await selectedPreferences(target, null);
        const previous = await readCatalog(target);
        const provider = selected(await catalog(target, captured.providerId), captured.providerId);
        const model = models(provider).find((model) => model.modelId === captured.modelId);
        if (!model)
          return {
            schemaVersion: 1,
            runtimeId: 'opencode',
            error: {
              code: 'model-missing',
              message: 'The selected model was not found in the current catalog.',
              recoverable: true,
            },
          };
        if (captured.probe !== false || provider.configuredAuthless) {
          const result = await createProbe(async () => target).test({
            runtimeId: 'opencode',
            providerId: captured.providerId,
            modelId: captured.modelId,
            projectPath,
          });
          if (!result.result?.ok)
            return {
              schemaVersion: 1,
              runtimeId: 'opencode',
              error: result.error ?? {
                code: 'model-test-failed',
                message: 'The selected model did not confirm access. No default was saved.',
                recoverable: true,
              },
            };
        } else if (!provider.connected && !model.free) {
          return {
            schemaVersion: 1,
            runtimeId: 'opencode',
            error: {
              code: 'auth-required',
              message: 'Connect or test the selected model before saving it as default.',
              recoverable: true,
            },
          };
        }
        await preferences.store!.setDefault(scope, captured.modelId);
        return await view(target, projectPath, previous);
      } catch {
        return unavailable();
      }
    },
    async clearProjectDefaultModel(input) {
      const captured = { ...input };
      if (!captured.projectPath) return unsupported();
      try {
        const target = await capture(captured);
        if (!target.preferences?.projectRoot) return unsupported();
        const preferences = await selectedPreferences(target, null);
        const previous = await readCatalog(target);
        await preferences.store!.setDefault('project', null);
        return await view(target, captured.projectPath, previous);
      } catch {
        return unavailable();
      }
    },
    async configureModelLimits(input) {
      const captured = { ...input };
      if (
        !captured.projectPath ||
        !validManagedModelLimits(captured.contextTokens, captured.outputTokens)
      )
        return unsupported();
      try {
        const target = await capture(captured);
        if (!target.preferences?.projectRoot) return unsupported();
        const preferences = await selectedPreferences(target, null);
        const provider = selected(await catalog(target, captured.providerId), captured.providerId);
        const model = models(provider).find((row) => row.modelId === captured.modelId);
        if (!model || model.routeKind !== 'configured_local') return unsupported();
        const result = await createProbe(async () => target).test(captured, {
          contextTokens: captured.contextTokens,
          outputTokens: captured.outputTokens,
        });
        if (!result.result?.ok)
          return {
            schemaVersion: 1,
            runtimeId: 'opencode',
            error: result.error ?? {
              code: 'model-test-failed',
              message:
                'The native model did not confirm the requested limits. No limits were saved.',
              recoverable: true,
            },
          };
        await preferences.store!.setLimits(
          captured.modelId,
          captured.contextTokens,
          captured.outputTokens
        );
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          result: {
            providerId: captured.providerId,
            modelId: captured.modelId,
            contextTokens: captured.contextTokens,
            outputTokens: captured.outputTokens,
            saved: true,
            verified: true,
            message: 'Model limits were applied, tested and saved for this project.',
            diagnostics: [],
          },
        };
      } catch {
        return unavailable();
      }
    },
    cancelModelLoad: async ({ requestGroupId }) => {
      for (const controller of modelLoads.get(requestGroupId) ?? []) controller.abort();
      modelLoads.delete(requestGroupId);
      return { ok: true };
    },
    cancelModelTest: (input) => probes.cancel(input),
    submitOAuthCode: (input) =>
      oauth
        ? oauth.submitCode(input)
        : Promise.resolve({ ok: false, error: 'Sign-in operation unavailable.' }),
    cancelOAuth: (input) =>
      oauth
        ? oauth.cancel(input)
        : Promise.resolve({ ok: false, error: 'Sign-in operation unavailable.' }),
    onOAuthProgress: (listener) => oauth?.subscribe(listener) ?? (() => {}),
  };
  return withCapturedClaudeAuthentication(port, deps.captureClaude, oauth);
}
