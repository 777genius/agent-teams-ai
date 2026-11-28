import { getErrorMessage } from '@shared/utils/errorHandling';
import { isVersionOlder } from '@shared/utils/version';

import type {
  CodexRuntimeInstallProgress,
  CodexRuntimeStatus,
} from '@features/codex-runtime-installer/contracts';

export function codexRuntimeProgressStatus(
  current: CodexRuntimeStatus | null,
  progress: CodexRuntimeInstallProgress
): CodexRuntimeStatus {
  return {
    installed: current?.installed ?? false,
    ...(current?.binaryPath ? { binaryPath: current.binaryPath } : {}),
    ...(current?.version ? { version: current.version } : {}),
    latestVersion: current?.latestVersion ?? null,
    updateAvailable: current?.updateAvailable ?? false,
    source: current?.source ?? 'missing',
    state: progress.phase,
    progress,
  };
}

export function codexRuntimeVersionStatus(
  status: CodexRuntimeStatus,
  latestVersion: string | null
): CodexRuntimeStatus {
  return {
    ...status,
    latestVersion,
    updateAvailable: Boolean(
      status.installed &&
      status.version &&
      latestVersion &&
      isVersionOlder(status.version, latestVersion)
    ),
  };
}

export function codexRuntimeMissingStatus(): CodexRuntimeStatus {
  return {
    installed: false,
    latestVersion: null,
    updateAvailable: false,
    source: 'missing',
    state: 'idle',
  };
}

export function codexRuntimePreferredStatus(
  managed: CodexRuntimeStatus,
  selectedPath: CodexRuntimeStatus
): CodexRuntimeStatus {
  return selectedPath.installed || managed.source !== 'app-managed' || managed.state !== 'failed'
    ? selectedPath
    : managed;
}

export function codexRuntimeUnavailableStatus(
  source: 'app-managed' | 'path',
  binaryPath: string,
  error: unknown,
  version?: string
): CodexRuntimeStatus {
  return {
    installed: false,
    binaryPath,
    ...(source === 'app-managed' ? { version } : {}),
    latestVersion: null,
    updateAvailable: false,
    source,
    state: 'failed',
    error: getErrorMessage(error),
  };
}

export function codexRuntimeObservedStatus(
  source: 'app-managed' | 'path',
  binaryPath: string,
  version: string | undefined
): CodexRuntimeStatus {
  return {
    installed: true,
    binaryPath,
    version,
    latestVersion: null,
    updateAvailable: false,
    source,
    state: 'ready',
  };
}

export function codexRuntimeInstalledStatus(
  binaryPath: string,
  version: string,
  latestVersion: string | null
): CodexRuntimeStatus {
  return {
    installed: true,
    binaryPath,
    version,
    latestVersion,
    updateAvailable: false,
    source: 'app-managed',
    state: 'ready',
    progress: { phase: 'ready', percent: 100, detail: `Installed Codex ${version}` },
  };
}

export function codexRuntimeFailedStatus(
  previousStatus: CodexRuntimeStatus | null,
  error: unknown
): CodexRuntimeStatus {
  return {
    ...(previousStatus ?? {
      installed: false,
      latestVersion: null,
      updateAvailable: false,
      source: 'missing' as const,
    }),
    state: 'failed',
    error: getErrorMessage(error),
    progress: { phase: 'failed', detail: getErrorMessage(error) },
  };
}
