import type { RuntimeProviderDirectoryCacheSnapshot } from '@features/runtime-provider-management/renderer';
import type { CliProviderId, CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

export const DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS = 2 * 60_000;
const MAIN_PROVIDER_IDS = ['anthropic', 'codex', 'gemini'] as const;

type MainProvider = Pick<
  CliProviderStatus,
  'providerId' | 'authenticated' | 'verificationState' | 'statusCheckOutcome'
>;

type Directory = Pick<
  RuntimeProviderDirectoryCacheSnapshot,
  'authoritative' | 'runtimeRevision' | 'totalCount' | 'nextCursor' | 'fetchedAt'
> & {
  entries: readonly Pick<RuntimeProviderDirectoryCacheSnapshot['entries'][number], 'providerId' | 'state'>[];
};

interface ConnectionSummaryInput {
  cliStatus: {
    installed: boolean;
    flavor: string;
    providers: readonly MainProvider[];
  } | null;
  cliStatusLoading: boolean;
  providerStatusLoading: Partial<Record<CliProviderId, boolean>>;
  projectPath: string | null;
  globalDirectory: Directory | null;
  projectDirectory: Directory | null;
  runtimeStatus: Pick<
    OpenCodeRuntimeStatus,
    'installed' | 'state' | 'version' | 'binaryPath'
  > | null;
  nowMs?: number;
}

export interface DashboardConnectionSummary {
  /** Null means not yet verified, not zero. A connection is not launch authority. */
  cliConnected: number | null;
  /** Only exact, complete, current-runtime OpenCode directory snapshots are counted. */
  openCodeConnected: number | null;
}

function isCompleteDirectory(
  directory: Directory | null,
  runtimeRevision: string | null,
  nowMs: number
): directory is Directory {
  const fetchedAt = Date.parse(directory?.fetchedAt ?? '');
  return Boolean(
    runtimeRevision &&
      Number.isFinite(fetchedAt) &&
      fetchedAt <= nowMs &&
      nowMs - fetchedAt <= DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS &&
      directory?.authoritative &&
      directory.runtimeRevision === runtimeRevision &&
      directory.totalCount !== undefined &&
      directory.totalCount !== null &&
      directory.totalCount === directory.entries.length &&
      directory.nextCursor == null
  );
}

/**
 * Passive dashboard-only view. Does not initiate a provider, directory, model or
 * account request. Counts CLI connections separately from OpenCode sources.
 */
export function getDashboardConnectionSummary({
  cliStatus,
  cliStatusLoading,
  providerStatusLoading,
  projectPath,
  globalDirectory,
  projectDirectory,
  runtimeStatus,
  nowMs = Date.now(),
}: ConnectionSummaryInput): DashboardConnectionSummary {
  const mainProviders =
    cliStatus?.flavor === 'agent_teams_orchestrator' && cliStatus.installed
      ? MAIN_PROVIDER_IDS.map((id) => cliStatus.providers.find((provider) => provider.providerId === id))
      : [];
  const cliReady =
    !cliStatusLoading &&
    mainProviders.length === MAIN_PROVIDER_IDS.length &&
    mainProviders.every(
      (provider) =>
        provider != null &&
        providerStatusLoading[provider.providerId] !== true &&
        (provider.statusCheckOutcome === 'authoritative' ||
          provider.statusCheckOutcome === 'model_only' ||
          (provider.statusCheckOutcome == null && provider.verificationState === 'verified'))
    );
  const cliConnected = cliReady
    ? mainProviders.filter((provider) => provider?.authenticated === true).length
    : null;

  const runtimeRevision =
    runtimeStatus?.installed === true && runtimeStatus.state === 'ready'
      ? JSON.stringify(['ready', runtimeStatus.version ?? null, runtimeStatus.binaryPath ?? null])
      : null;
  const globalComplete = isCompleteDirectory(globalDirectory, runtimeRevision, nowMs);
  const projectComplete =
    projectPath === null || isCompleteDirectory(projectDirectory, runtimeRevision, nowMs);

  if (!globalComplete || !projectComplete) {
    return { cliConnected, openCodeConnected: null };
  }

  // The project snapshot may override a global connection with the same ID;
  // count source identities, never models, local routes or the OpenCode host.
  const entries = new Map(
    globalDirectory.entries.map((entry) => [entry.providerId.trim().toLowerCase(), entry] as const)
  );
  if (projectPath !== null && projectDirectory) {
    for (const entry of projectDirectory.entries) {
      entries.set(entry.providerId.trim().toLowerCase(), entry);
    }
  }
  let openCodeConnected = 0;
  for (const [id, entry] of entries) {
    if (id && id !== 'opencode' && entry.state === 'connected') {
      openCodeConnected += 1;
    }
  }

  return { cliConnected, openCodeConnected };
}
