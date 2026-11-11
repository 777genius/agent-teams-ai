import { isGeminiUiFrozen } from '@renderer/utils/geminiUiFreeze';

import type {
  RuntimeProviderConnectedCountObservation,
  RuntimeProviderDirectoryCacheSnapshot,
} from '@features/runtime-provider-management/renderer';
import type { CliProviderId, CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

export const DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS = 2 * 60_000;
// Gemini is deliberately unavailable in the current UI: never wait for its status.
const MAIN_PROVIDER_IDS: readonly CliProviderId[] = isGeminiUiFrozen()
  ? ['anthropic', 'codex']
  : ['anthropic', 'codex', 'gemini'];

type MainProvider = Pick<
  CliProviderStatus,
  'providerId' | 'authenticated' | 'verificationState' | 'statusCheckOutcome'
>;

type Directory = Pick<
  RuntimeProviderDirectoryCacheSnapshot,
  'authoritative' | 'runtimeRevision' | 'totalCount' | 'nextCursor' | 'fetchedAt'
> & {
  entries: readonly Pick<
    RuntimeProviderDirectoryCacheSnapshot['entries'][number],
    'providerId' | 'state'
  >[];
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
  observedOpenCodeCount?: RuntimeProviderConnectedCountObservation | null;
  countInvalidated?: boolean;
  /** An actual scoped connection-directory read is in flight. */
  countChecking?: boolean;
  runtimeStatus: Pick<
    OpenCodeRuntimeStatus,
    'installed' | 'state' | 'version' | 'binaryPath'
  > | null;
  nowMs?: number;
}

export interface DashboardConnectionSummary {
  /** Null means not yet verified, not zero. A connection is not launch authority. */
  cliConnected: number | null;
  /** False means some CLI statuses remain unknown; connected count is only a lower bound. */
  cliCountComplete: boolean;
  /** True only while a known CLI provider status check is in progress. */
  cliCountPending: boolean;
  /** Only exact, complete, current-runtime OpenCode directory snapshots are counted. */
  openCodeConnected: number | null;
  /** Fresh connected rows from an incomplete directory, never an exact total. */
  openCodeKnownConnected?: number;
  /** Previous scoped observation, displayed only during a bounded active recheck. */
  openCodePreviousConnected?: number;
}

function isCompleteDirectory(
  directory: Directory | null,
  runtimeRevision: string | null,
  nowMs: number,
  maxAgeMs = DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS
): directory is Directory {
  const fetchedAt = Date.parse(directory?.fetchedAt ?? '');
  return Boolean(
    runtimeRevision &&
    Number.isFinite(fetchedAt) &&
    fetchedAt <= nowMs &&
    nowMs - fetchedAt <= maxAgeMs &&
    directory?.authoritative &&
    directory.runtimeRevision === runtimeRevision &&
    directory.totalCount !== undefined &&
    directory.totalCount !== null &&
    directory.totalCount === directory.entries.length &&
    directory.nextCursor == null &&
    directory.entries.every((entry) => entry.state !== 'error')
  );
}

function countDirectoryConnections(
  globalDirectory: Directory,
  projectDirectory: Directory | null
): number {
  const entries = new Map(
    globalDirectory.entries.map((entry) => [entry.providerId.trim().toLowerCase(), entry] as const)
  );
  for (const entry of projectDirectory?.entries ?? []) {
    entries.set(entry.providerId.trim().toLowerCase(), entry);
  }
  return [...entries].filter(
    ([id, entry]) => id && id !== 'opencode' && entry.state === 'connected'
  ).length;
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
  observedOpenCodeCount,
  countInvalidated = false,
  countChecking = false,
  runtimeStatus,
  nowMs = Date.now(),
}: ConnectionSummaryInput): DashboardConnectionSummary {
  const mainProviders =
    cliStatus?.flavor === 'agent_teams_orchestrator' && cliStatus.installed
      ? MAIN_PROVIDER_IDS.map((id) =>
          cliStatus.providers.find((provider) => provider.providerId === id)
        )
      : [];
  const settled = (provider: MainProvider | undefined): provider is MainProvider =>
    provider != null &&
    providerStatusLoading[provider.providerId] !== true &&
    (provider.statusCheckOutcome === 'authoritative' ||
      provider.statusCheckOutcome === 'model_only' ||
      (provider.statusCheckOutcome == null && provider.verificationState === 'verified'));
  const cliCountPending =
    cliStatusLoading ||
    MAIN_PROVIDER_IDS.some(
      (id) =>
        providerStatusLoading[id] === true ||
        cliStatus?.providers.find((provider) => provider.providerId === id)?.statusCheckOutcome ===
          'pending'
    );
  const cliCountComplete =
    !cliCountPending &&
    mainProviders.length === MAIN_PROVIDER_IDS.length &&
    mainProviders.every(settled);
  const knownConnected = mainProviders.filter(
    (provider) => settled(provider) && provider.authenticated
  ).length;
  // A completed partial scan can establish "at least 0 connected" if one
  // provider was checked. Do not present it as an exact total.
  const cliConnected =
    cliCountComplete || knownConnected > 0 || (!cliCountPending && mainProviders.some(settled))
      ? knownConnected
      : null;

  const runtimeRevision =
    runtimeStatus?.installed === true && runtimeStatus.state === 'ready'
      ? JSON.stringify(['ready', runtimeStatus.version ?? null, runtimeStatus.binaryPath ?? null])
      : null;
  // A complete connected-only observation is scoped and independent of the
  // full provider/model directory. It never grants permission to launch.
  const countFetchedAt = Date.parse(observedOpenCodeCount?.fetchedAt ?? '');
  const globalComplete = isCompleteDirectory(globalDirectory, runtimeRevision, nowMs);
  const projectComplete =
    projectPath === null || isCompleteDirectory(projectDirectory, runtimeRevision, nowMs);
  // Newer global evidence may revoke inherited project credentials even when
  // the project directory is still incomplete. Never keep its older count.
  const newerGlobalEvidence =
    globalComplete && Date.parse(globalDirectory.fetchedAt) > countFetchedAt;
  const newerProjectEvidence =
    projectPath !== null &&
    projectComplete &&
    projectDirectory !== null &&
    Date.parse(projectDirectory.fetchedAt) > countFetchedAt;
  const newerCompleteDirectory = newerGlobalEvidence || newerProjectEvidence;
  if (
    !countInvalidated &&
    !newerCompleteDirectory &&
    runtimeRevision &&
    observedOpenCodeCount?.runtimeRevision === runtimeRevision &&
    Number.isFinite(countFetchedAt) &&
    countFetchedAt <= nowMs &&
    nowMs - countFetchedAt <= DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS
  ) {
    return {
      cliConnected,
      cliCountComplete,
      cliCountPending,
      openCodeConnected: observedOpenCodeCount.connected,
    };
  }

  if (countInvalidated || !globalComplete || !projectComplete) {
    // Partial scoped summaries still establish connected identities. Use only
    // current-runtime, fresh rows, and never inherit a global row into a project
    // whose override is unknown. Mutations revoke this evidence altogether.
    const partial = projectPath === null ? globalDirectory : projectDirectory;
    const fetchedAt = Date.parse(partial?.fetchedAt ?? '');
    const knownIds = new Set(
      !countInvalidated &&
        runtimeRevision &&
        partial?.runtimeRevision === runtimeRevision &&
        Number.isFinite(fetchedAt) &&
        fetchedAt <= nowMs &&
        nowMs - fetchedAt <= DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS
        ? partial.entries
            .filter((entry) => entry.state === 'connected')
            .map((entry) => entry.providerId.trim().toLowerCase())
            .filter((id) => id && id !== 'opencode')
        : []
    );
    let previousConnected: number | undefined;
    if (countChecking && !countInvalidated && runtimeRevision) {
      // Keep a previous number only while this scope is being rechecked, for
      // at most one additional freshness window. It remains display data and
      // never becomes an exact current total or model/launch authority.
      const newerCachedEvidence = [globalDirectory, projectDirectory].some(
        (directory) =>
          directory?.runtimeRevision === runtimeRevision &&
          directory.authoritative &&
          Date.parse(directory.fetchedAt) > countFetchedAt
      );
      if (
        !newerCachedEvidence &&
        observedOpenCodeCount?.runtimeRevision === runtimeRevision &&
        Number.isFinite(countFetchedAt) &&
        countFetchedAt <= nowMs &&
        nowMs - countFetchedAt <= 2 * DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS
      ) {
        previousConnected = observedOpenCodeCount.connected;
      } else {
        const recheckMaxAgeMs = 2 * DASHBOARD_PROVIDER_CACHE_MAX_AGE_MS;
        if (
          isCompleteDirectory(globalDirectory, runtimeRevision, nowMs, recheckMaxAgeMs) &&
          (projectPath === null ||
            isCompleteDirectory(projectDirectory, runtimeRevision, nowMs, recheckMaxAgeMs))
        ) {
          previousConnected = countDirectoryConnections(
            globalDirectory,
            projectPath === null ? null : projectDirectory
          );
        }
      }
    }
    return {
      cliConnected,
      cliCountComplete,
      cliCountPending,
      openCodeConnected: null,
      ...(knownIds.size > 0 ? { openCodeKnownConnected: knownIds.size } : {}),
      ...(previousConnected !== undefined ? { openCodePreviousConnected: previousConnected } : {}),
    };
  }

  // The project snapshot may override a global connection with the same ID;
  // count source identities, never models, local routes or the OpenCode host.
  const openCodeConnected = countDirectoryConnections(
    globalDirectory,
    projectPath === null ? null : projectDirectory
  );

  return { cliConnected, cliCountComplete, cliCountPending, openCodeConnected };
}
