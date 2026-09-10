import type {
  OpenCodeBridgeResult,
  OpenCodeCleanupHostsCommandBody,
  OpenCodeCleanupHostsCommandData,
  OpenCodeStartupCleanupStatus,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';
import type { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget';

// The runtime also retains hosts awaiting OAuth publication.
type StartupCleanupHost = Omit<OpenCodeCleanupHostsCommandData['hosts'][number], 'action'> & {
  action: OpenCodeCleanupHostsCommandData['hosts'][number]['action'] | 'kept_pending_oauth';
};

export type OpenCodeStartupCleanupData = Omit<OpenCodeCleanupHostsCommandData, 'hosts'> & {
  hosts: StartupCleanupHost[];
  startupCleanup: OpenCodeStartupCleanupStatus;
};

/** Preserve transport failures; launcher exit and timeout cannot acknowledge drainage. */
export async function executeOpenCodeStartupCleanup(
  bridge: OpenCodeReadinessBridgeCommandExecutor,
  budget: OpenCodeStartupCleanupBudget,
  appStartedAtMs = Date.now(),
  canDispatch?: () => boolean,
  requestId?: string
): Promise<OpenCodeBridgeResult<OpenCodeStartupCleanupData>> {
  return bridge.execute<
    OpenCodeCleanupHostsCommandBody & { deadlineUnixMs: number },
    OpenCodeStartupCleanupData
  >(
    'opencode.cleanupStartupHosts',
    {
      reason: 'startup',
      mode: 'stale',
      staleAgeMs: 5 * 60_000 + Math.max(0, Date.now() - appStartedAtMs),
      leaseStaleAgeMs: 24 * 60 * 60_000,
      preflightLeaseStaleAgeMs: 6 * 60_000,
      deadlineUnixMs: budget.deadlineUnixMs,
    },
    { cwd: process.cwd(), timeoutMs: budget.capMs(120_000), canDispatch, requestId }
  );
}

export function isStartupCleanupData(value: unknown): value is OpenCodeStartupCleanupData {
  if (!value || typeof value !== 'object') return false;
  const data = value as OpenCodeStartupCleanupData;
  const status = data.startupCleanup;
  if (
    !(
      Number.isSafeInteger(data.cleaned) &&
      data.cleaned >= 0 &&
      Number.isSafeInteger(data.remaining) &&
      data.remaining >= 0 &&
      status &&
      ['drained', 'unknown'].includes(status.completion) &&
      ['complete', 'partial'].includes(status.coverage) &&
      Array.isArray(status.survivingPids) &&
      status.survivingPids.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
      Array.isArray(data.hosts) &&
      data.hosts.every(
        (host) =>
          host &&
          typeof host === 'object' &&
          typeof host.hostKey === 'string' &&
          typeof host.projectPath === 'string' &&
          Number.isSafeInteger(host.pid) &&
          host.pid > 0 &&
          Number.isSafeInteger(host.port) &&
          host.port > 0 &&
          host.port <= 65535 &&
          [
            'disposed',
            'removed_dead',
            'kept_active',
            'kept_leased',
            'kept_recent',
            'kept_filtered',
            'kept_pending_oauth',
            'failed',
          ].includes(host.action) &&
          typeof host.reason === 'string' &&
          Number.isSafeInteger(host.leaseCount) &&
          host.leaseCount >= 0
      ) &&
      Array.isArray(data.diagnostics) &&
      data.diagnostics.every((item) => typeof item === 'string')
    )
  )
    return false;

  const removed = data.hosts.filter(
    (host) => host.action === 'disposed' || host.action === 'removed_dead'
  );
  if (data.cleaned > removed.length) return false;
  const survivors = new Set(status.survivingPids);
  // Registry keys, returned host keys and unique PIDs need not correspond one
  // to one. Filtered records and pending helpers also preclude count equality.
  if (data.remaining > 0 && survivors.size === 0) return false;
  if (status.completion === 'unknown' && survivors.size === 0) return false;
  return data.hosts.every((host) => {
    if (host.action === 'disposed' || host.action === 'removed_dead') return true;
    if (!survivors.has(host.pid)) return false;
    return !['failed', 'kept_active'].includes(host.action) || status.coverage === 'partial';
  });
}
