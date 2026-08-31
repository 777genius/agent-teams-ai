import fs from 'node:fs';
import path from 'node:path';

import { resolveClaudeMultimodelDataHomePath } from '@features/token-usage/main';
import { verifyAnthropicApiKeyWithApi } from '@main/utils/anthropicApiKeyVerification';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { isOpenCodeProviderVerifyFailure } from './openCodeConnectVerifyFailure';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';
import type { AnthropicApiKeyVerificationResult } from '@main/utils/anthropicApiKeyVerification';

const AUTH_STORE_MAX_BYTES = 2 * 1024 * 1024;
const AUTH_STORE_WRITE_MAX_ATTEMPTS = 3;

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

/**
 * The setup-form dialog connects through `runtime providers connect` with an
 * api method instead of `connect-api-key`; its verify probes hit the same
 * key-not-active-yet failure. Normalize either input shape onto the recovery
 * input when a key is present (OAuth connects have nothing to recover).
 */
export function resolveConnectRecoveryInput(
  input: RuntimeProviderManagementConnectApiKeyInput | RuntimeProviderManagementConnectInput
): RuntimeProviderManagementConnectApiKeyInput | null {
  const isOAuthConnect = 'method' in input && input.method === 'oauth';
  const apiKey = isOAuthConnect ? '' : (input.apiKey ?? '').trim();
  if (!apiKey) {
    return null;
  }
  return {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    apiKey,
    projectPath: input.projectPath,
  };
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

class OpenCodeAuthStoreConflictError extends Error {}

/**
 * Read-modify-write of the shared auth store, guarded against a concurrent
 * writer losing its entry.
 *
 * The store holds every provider's credential, so any write has to republish
 * the whole file. `atomicWriteAsync` publishes by rename, so the file is never
 * torn — but a plain read-then-write would still overwrite whatever another
 * writer committed while our replacement was being staged. The `beforeCommit`
 * seam re-reads the store immediately before the rename and refuses to publish
 * over content that no longer matches what we read, so a conflicting write is
 * retried against the freshest snapshot instead of erasing it.
 *
 * This is not a true compare-and-swap: the store layer offers no file locking,
 * so a writer landing between the guard's read and the rename can still be
 * lost. That window is one rename wide rather than the whole stage-and-fsync,
 * which is as narrow as this can get without a lock.
 *
 * `apply` mutates only this fallback's own provider key and returns false when
 * there is nothing to write.
 */
async function updateOpenCodeAuthStore(
  authStorePath: string,
  apply: (store: Record<string, unknown>) => boolean
): Promise<void> {
  for (let attempt = 1; attempt <= AUTH_STORE_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const store = await readOpenCodeAuthStore(authStorePath);
    const witness = JSON.stringify(store);
    if (!apply(store)) {
      return;
    }
    try {
      await atomicWriteAsync(authStorePath, `${JSON.stringify(store, null, 2)}\n`, {
        mode: 0o600,
        beforeCommit: async () => {
          if (JSON.stringify(await readOpenCodeAuthStore(authStorePath)) !== witness) {
            throw new OpenCodeAuthStoreConflictError();
          }
        },
      });
      return;
    } catch (error) {
      if (!(error instanceof OpenCodeAuthStoreConflictError)) {
        throw error;
      }
    }
  }
  throw new Error(
    `OpenCode auth store at ${authStorePath} kept changing while the credential was written`
  );
}

async function commitOpenCodeApiCredential(input: {
  authStorePath: string;
  providerId: string;
  apiKey: string;
}): Promise<OpenCodeAuthStoreCredentialSnapshot> {
  let snapshot: OpenCodeAuthStoreCredentialSnapshot = {
    previousCredential: undefined,
    hadPreviousCredential: false,
  };
  await updateOpenCodeAuthStore(input.authStorePath, (store) => {
    // Re-snapshotted on every attempt so a retry restores what the winning
    // writer left behind, not what the losing attempt had read.
    snapshot = {
      previousCredential: store[input.providerId],
      hadPreviousCredential: Object.hasOwn(store, input.providerId),
    };
    store[input.providerId] = { type: 'api', key: input.apiKey };
    return true;
  });
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
  await updateOpenCodeAuthStore(input.authStorePath, (store) => {
    // Only undo the exact credential this fallback committed; a concurrent
    // writer's newer entry is never rolled back.
    if (!isCommittedApiCredential(store[input.providerId], input.apiKey)) {
      return false;
    }
    if (input.snapshot.hadPreviousCredential) {
      store[input.providerId] = input.snapshot.previousCredential;
    } else {
      delete store[input.providerId];
    }
    return true;
  });
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
 * still does not report connected — or the status re-read itself fails — the
 * committed credential is rolled back and the original failure is returned
 * with an explanation. Every path that reports failure leaves the auth store
 * as it found it. The fallback never throws and never replaces a response it
 * could not improve.
 */
export async function recoverOpenCodeConnectApiKeyVerifyFailure(
  connectInput: RuntimeProviderManagementConnectApiKeyInput | RuntimeProviderManagementConnectInput,
  response: RuntimeProviderManagementProviderResponse,
  host: OpenCodeConnectApiKeyFallbackHost,
  overrides: OpenCodeConnectApiKeyFallbackOverrides = {}
): Promise<RuntimeProviderManagementProviderResponse> {
  if (!isOpenCodeProviderVerifyFailure(response)) {
    return response;
  }
  const input = resolveConnectRecoveryInput(connectInput);
  const providerId = input?.providerId.trim() ?? '';
  const verifier = (overrides.verifiers ?? APP_SIDE_API_KEY_VERIFIERS)[providerId.toLowerCase()];
  if (!input || !verifier || !providerId) {
    return response;
  }

  // Set once the credential is in the store, so any later failure — including
  // a host that throws instead of returning a failed view — undoes the commit
  // before the original failure is reported.
  let committed: {
    authStorePath: string;
    snapshot: OpenCodeAuthStoreCredentialSnapshot;
  } | null = null;
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
    committed = { authStorePath, snapshot };
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
    // The fallback must never make the original failure worse — and a failure
    // reported after the commit must not leave the credential behind.
    if (committed) {
      await rollbackOpenCodeApiCredential({
        authStorePath: committed.authStorePath,
        providerId,
        apiKey: input.apiKey,
        snapshot: committed.snapshot,
      }).catch(() => undefined);
      try {
        host.invalidateProviderCaches();
      } catch {
        // A cache invalidation that throws is already the failure being handled.
      }
    }
    return response;
  }
}
