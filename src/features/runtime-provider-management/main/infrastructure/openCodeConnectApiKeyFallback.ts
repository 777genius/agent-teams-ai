import fs from 'node:fs';
import path from 'node:path';

import { resolveClaudeMultimodelDataHomePath } from '@features/token-usage/main';
import { verifyAnthropicApiKeyWithApi } from '@main/utils/anthropicApiKeyVerification';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { isOpenCodeProviderVerifyFailure } from './openCodeConnectVerifyFailure';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';
import type { AnthropicApiKeyVerificationResult } from '@main/utils/anthropicApiKeyVerification';

const AUTH_STORE_MAX_BYTES = 2 * 1024 * 1024;

type AppSideApiKeyVerifier = (apiKey: string) => Promise<AnthropicApiKeyVerificationResult>;

/**
 * Providers whose API keys the app can verify directly against the provider
 * API when the runtime-side model probe cannot. Keys are lower-case OpenCode
 * provider ids.
 */
const APP_SIDE_API_KEY_VERIFIERS: Readonly<Record<string, AppSideApiKeyVerifier>> = {
  anthropic: (apiKey) => verifyAnthropicApiKeyWithApi(apiKey),
};

/**
 * The global claude-multimodel OpenCode auth store the orchestrator's
 * connect-api-key command persists credentials into; managed profiles inherit
 * from it. Shape: `{ "<providerId>": { "type": "api", "key": "<key>" } }`.
 */
export function resolveOpenCodeGlobalAuthStorePath(): string {
  return path.join(resolveClaudeMultimodelDataHomePath(), 'opencode', 'auth.json');
}

interface OpenCodeAuthStoreCredentialSnapshot {
  previousCredential: unknown;
  hadPreviousCredential: boolean;
}

async function readOpenCodeAuthStore(authStorePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    const stats = await fs.promises.stat(authStorePath);
    // An unreadable or oversized store must abort the fallback instead of
    // being clobbered by a rewrite that would drop other providers' logins.
    if (!stats.isFile() || stats.size > AUTH_STORE_MAX_BYTES) {
      throw new Error(`OpenCode auth store at ${authStorePath} is not a readable JSON file`);
    }
    raw = await fs.promises.readFile(authStorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenCode auth store at ${authStorePath} is not a JSON object`);
  }
  return { ...(parsed as Record<string, unknown>) };
}

async function writeOpenCodeAuthStore(
  authStorePath: string,
  store: Record<string, unknown>
): Promise<void> {
  await atomicWriteAsync(authStorePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function commitOpenCodeApiCredential(input: {
  authStorePath: string;
  providerId: string;
  apiKey: string;
}): Promise<OpenCodeAuthStoreCredentialSnapshot> {
  const store = await readOpenCodeAuthStore(input.authStorePath);
  const snapshot: OpenCodeAuthStoreCredentialSnapshot = {
    previousCredential: store[input.providerId],
    hadPreviousCredential: Object.hasOwn(store, input.providerId),
  };
  store[input.providerId] = { type: 'api', key: input.apiKey };
  await writeOpenCodeAuthStore(input.authStorePath, store);
  return snapshot;
}

function isCommittedApiCredential(value: unknown, apiKey: string): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'api' &&
    (value as { key?: unknown }).key === apiKey
  );
}

async function rollbackOpenCodeApiCredential(input: {
  authStorePath: string;
  providerId: string;
  apiKey: string;
  snapshot: OpenCodeAuthStoreCredentialSnapshot;
}): Promise<void> {
  const store = await readOpenCodeAuthStore(input.authStorePath);
  // Only undo the exact credential this fallback committed; a concurrent
  // writer's newer entry is never rolled back.
  if (!isCommittedApiCredential(store[input.providerId], input.apiKey)) {
    return;
  }
  if (input.snapshot.hadPreviousCredential) {
    store[input.providerId] = input.snapshot.previousCredential;
  } else {
    delete store[input.providerId];
  }
  await writeOpenCodeAuthStore(input.authStorePath, store);
}

function findProviderConnection(
  view: RuntimeProviderManagementViewResponse,
  providerId: string
): RuntimeProviderConnectionDto | null {
  return view.view?.providers.find((provider) => provider.providerId === providerId) ?? null;
}

function enrichVerifyFailureResponse(
  response: RuntimeProviderManagementProviderResponse,
  note: string,
  hints: readonly string[]
): RuntimeProviderManagementProviderResponse {
  if (!response.error) {
    return response;
  }
  return {
    ...response,
    error: {
      ...response.error,
      message: `${response.error.message}\n${note}`,
      diagnostics: response.error.diagnostics
        ? { ...response.error.diagnostics, hints: [...response.error.diagnostics.hints, ...hints] }
        : (response.error.diagnostics ?? null),
    },
  };
}

export interface OpenCodeConnectApiKeyFallbackHost {
  loadView(
    input: RuntimeProviderManagementLoadViewInput
  ): Promise<RuntimeProviderManagementViewResponse>;
  invalidateProviderCaches(): void;
}

/** Test seams; production callers omit them. */
export interface OpenCodeConnectApiKeyFallbackOverrides {
  verifiers?: Readonly<Record<string, AppSideApiKeyVerifier>>;
  authStorePath?: string;
}

/**
 * Commit-then-verify fallback for OpenCode "Connect & verify" with an API key.
 *
 * The orchestrator CLI verifies a submitted key by probing catalog models, but
 * OpenCode only activates a store-backed provider once its credential is in
 * the auth store, so that probe runs without the key and always fails. When a
 * connect-api-key response carries that probe-failure signature and the app
 * can verify the key directly against the provider API, the valid key is
 * committed to the auth store and provider status is re-read; if the provider
 * still does not report connected, the committed credential is rolled back and
 * the original failure is returned with an explanation. The fallback never
 * throws and never replaces a response it could not improve.
 */
export async function recoverOpenCodeConnectApiKeyVerifyFailure(
  input: RuntimeProviderManagementConnectApiKeyInput,
  response: RuntimeProviderManagementProviderResponse,
  host: OpenCodeConnectApiKeyFallbackHost,
  overrides: OpenCodeConnectApiKeyFallbackOverrides = {}
): Promise<RuntimeProviderManagementProviderResponse> {
  if (!isOpenCodeProviderVerifyFailure(response)) {
    return response;
  }
  const providerId = input.providerId.trim();
  const verifier = (overrides.verifiers ?? APP_SIDE_API_KEY_VERIFIERS)[providerId.toLowerCase()];
  if (!verifier || !providerId || !input.apiKey.trim()) {
    return response;
  }

  try {
    const verification = await verifier(input.apiKey);
    if (verification.state !== 'valid') {
      return response;
    }

    const authStorePath = overrides.authStorePath ?? resolveOpenCodeGlobalAuthStorePath();
    const snapshot = await commitOpenCodeApiCredential({
      authStorePath,
      providerId,
      apiKey: input.apiKey,
    });
    host.invalidateProviderCaches();
    const view = await host.loadView({
      runtimeId: input.runtimeId,
      projectPath: input.projectPath ?? null,
    });
    const provider = findProviderConnection(view, providerId);
    if (provider?.state === 'connected') {
      return { schemaVersion: 1, runtimeId: input.runtimeId, provider };
    }

    let rollbackNote = 'the committed credential was rolled back.';
    try {
      await rollbackOpenCodeApiCredential({
        authStorePath,
        providerId,
        apiKey: input.apiKey,
        snapshot,
      });
    } catch {
      rollbackNote = `the committed credential could not be rolled back; review ${authStorePath}.`;
    }
    host.invalidateProviderCaches();
    return enrichVerifyFailureResponse(
      response,
      `The app then verified the API key directly with the ${providerId} API and committed it to the OpenCode auth store, but OpenCode still did not report the provider as connected, so ${rollbackNote}`,
      [
        'The API key itself is valid: the app verified it directly against the provider API.',
        'OpenCode did not pick up the committed credential; refresh the provider catalog and try again.',
      ]
    );
  } catch {
    // The fallback must never make the original failure worse.
    return response;
  }
}
