import {
  commandArgEquals,
  extractCliArgValues,
} from '@main/services/team/TeamRuntimeLivenessResolver';

import type { RuntimeProcessTableRow } from '@features/tmux-installer/main';
import type { TeamAgentRuntimeLoadScope } from '@shared/types/team';

export interface RuntimeProcessUsageStats {
  rssBytes?: number;
  cpuPercent?: number;
}

export interface RuntimeProcessLoadStats extends RuntimeProcessUsageStats {
  primaryCpuPercent?: number;
  primaryRssBytes?: number;
  childCpuPercent?: number;
  childRssBytes?: number;
  processCount?: number;
  runtimeLoadScope?: TeamAgentRuntimeLoadScope;
  runtimeLoadTruncated?: boolean;
}

export type RuntimeTelemetryProcessSource = 'native' | 'wsl' | 'windows-host';

export interface RuntimeTelemetryProcessTableRow
  extends RuntimeProcessTableRow, RuntimeProcessUsageStats {
  runtimeTelemetrySource?: RuntimeTelemetryProcessSource;
}

export interface RuntimeUsageProcessTree {
  pids: number[];
  truncated: boolean;
}

export interface RuntimeUsageProcessTreeLimits {
  maxPidsPerRoot: number;
  maxPidsPerSnapshot: number;
}

export class RuntimeTelemetryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeTelemetryTimeoutError';
  }
}

export async function withRuntimeTelemetryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RuntimeTelemetryTimeoutError(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function isRuntimePidusageTelemetryEnabled(
  env: Partial<Pick<NodeJS.ProcessEnv, 'CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED'>> = process.env
): boolean {
  const value = env.CLAUDE_TEAM_RUNTIME_PIDUSAGE_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function normalizeRuntimeTelemetryNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeRuntimeProcessUsageStats(
  stat: unknown
): RuntimeProcessUsageStats | undefined {
  if (!stat || typeof stat !== 'object') {
    return undefined;
  }
  const candidate = stat as {
    memory?: unknown;
    cpu?: unknown;
    rssBytes?: unknown;
    cpuPercent?: unknown;
  };
  const rssBytes =
    normalizeRuntimeTelemetryNumber(candidate.memory) ??
    normalizeRuntimeTelemetryNumber(candidate.rssBytes);
  const cpuPercent =
    normalizeRuntimeTelemetryNumber(candidate.cpu) ??
    normalizeRuntimeTelemetryNumber(candidate.cpuPercent);
  const normalized: RuntimeProcessUsageStats = {
    ...(rssBytes != null && rssBytes >= 0 ? { rssBytes } : {}),
    ...(cpuPercent != null && cpuPercent >= 0 ? { cpuPercent } : {}),
  };
  return normalized.rssBytes != null || normalized.cpuPercent != null ? normalized : undefined;
}

export function normalizeRuntimeProcessRowsForTelemetry(
  rows: unknown,
  source?: RuntimeTelemetryProcessSource
): RuntimeTelemetryProcessTableRow[] | null {
  if (!Array.isArray(rows)) {
    return null;
  }
  const normalizedRows: RuntimeTelemetryProcessTableRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const candidate = row as Partial<RuntimeTelemetryProcessTableRow>;
    const rawPid = normalizeRuntimeTelemetryNumber(candidate.pid);
    const rawPpid = normalizeRuntimeTelemetryNumber(candidate.ppid);
    const pid = Number.isInteger(rawPid) ? rawPid : undefined;
    const ppid = Number.isInteger(rawPpid) ? rawPpid : undefined;
    const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
    if (pid != null && pid > 0 && ppid != null && ppid >= 0 && command.length > 0) {
      const runtimeTelemetrySource =
        source ??
        (candidate.runtimeTelemetrySource === 'native' ||
        candidate.runtimeTelemetrySource === 'wsl' ||
        candidate.runtimeTelemetrySource === 'windows-host'
          ? candidate.runtimeTelemetrySource
          : undefined);
      const usageStats = normalizeRuntimeProcessUsageStats(candidate);
      normalizedRows.push({
        pid,
        ppid,
        command,
        ...(usageStats ?? {}),
        ...(runtimeTelemetrySource ? { runtimeTelemetrySource } : {}),
      });
    }
  }
  return normalizedRows;
}

export function buildRuntimeProcessChildrenByParent(
  processRows: readonly RuntimeTelemetryProcessTableRow[]
): Map<number, RuntimeTelemetryProcessTableRow[]> {
  const childrenByParent = new Map<number, RuntimeTelemetryProcessTableRow[]>();
  for (const row of processRows) {
    const current = childrenByParent.get(row.ppid) ?? [];
    current.push(row);
    childrenByParent.set(row.ppid, current);
  }
  return childrenByParent;
}

export function addRuntimeRootOwnersFromProcessRows(params: {
  teamName: string;
  processRows: readonly RuntimeTelemetryProcessTableRow[] | null;
  rootOwnersByPid: Map<number, Set<string>>;
  platform: NodeJS.Platform;
}): void {
  if (!params.processRows || params.processRows.length === 0) {
    return;
  }

  for (const row of params.processRows) {
    if (params.platform === 'win32' && row.runtimeTelemetrySource === 'wsl') {
      continue;
    }
    if (!commandArgEquals(row.command, '--team-name', params.teamName)) {
      continue;
    }
    const agentNames = extractCliArgValues(row.command, '--agent-name');
    const agentIds = extractCliArgValues(row.command, '--agent-id');
    const ownerKey =
      agentNames.find((value) => value.trim().length > 0)?.trim() ??
      agentIds
        .map((value) => value.split('@', 1)[0]?.trim() ?? '')
        .find((value) => value.length > 0);
    if (!ownerKey) {
      continue;
    }
    const owners = params.rootOwnersByPid.get(row.pid) ?? new Set<string>();
    owners.add(ownerKey);
    params.rootOwnersByPid.set(row.pid, owners);
  }
}

function haveSameRootOwners(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined
): boolean {
  if (!left || left.size !== right?.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export function buildRuntimeUsageProcessTrees(params: {
  rootPids: readonly number[];
  processRows: readonly RuntimeTelemetryProcessTableRow[] | null;
  rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>;
  limits: RuntimeUsageProcessTreeLimits;
  platform: NodeJS.Platform;
}): Map<number, RuntimeUsageProcessTree> {
  const uniqueRoots = [
    ...new Set(params.rootPids.filter((pid) => Number.isFinite(pid) && pid > 0)),
  ];
  const rootOwnerKeysByPid = new Map<number, ReadonlySet<string>>();
  for (const [pid, owners] of params.rootOwnersByPid ?? []) {
    if (Number.isFinite(pid) && pid > 0 && owners.size > 0) {
      rootOwnerKeysByPid.set(pid, owners);
    }
  }
  for (const rootPid of uniqueRoots) {
    if (!rootOwnerKeysByPid.has(rootPid)) {
      rootOwnerKeysByPid.set(rootPid, new Set([String(rootPid)]));
    }
  }
  const usageTreesByRootPid = new Map<number, RuntimeUsageProcessTree>();
  const scheduledPids = new Set<number>();
  const normalizedProcessRows = normalizeRuntimeProcessRowsForTelemetry(params.processRows);

  if (!normalizedProcessRows || normalizedProcessRows.length === 0) {
    for (const rootPid of uniqueRoots) {
      if (scheduledPids.size >= params.limits.maxPidsPerSnapshot) {
        usageTreesByRootPid.set(rootPid, { pids: [], truncated: true });
        continue;
      }
      scheduledPids.add(rootPid);
      usageTreesByRootPid.set(rootPid, { pids: [rootPid], truncated: false });
    }
    return usageTreesByRootPid;
  }

  const childrenByParent = buildRuntimeProcessChildrenByParent(normalizedProcessRows);
  const rowByPid = new Map(normalizedProcessRows.map((row) => [row.pid, row]));
  const missingRootPids: number[] = [];
  for (const rootPid of uniqueRoots) {
    const pids: number[] = [];
    let truncated = false;
    const rootProcessRow = rowByPid.get(rootPid);
    if (!rootProcessRow) {
      missingRootPids.push(rootPid);
      usageTreesByRootPid.set(rootPid, { pids: [], truncated: false });
      continue;
    }
    if (params.platform === 'win32' && rootProcessRow?.runtimeTelemetrySource === 'wsl') {
      usageTreesByRootPid.set(rootPid, { pids: [], truncated: false });
      continue;
    }
    const rootProcessSource = rootProcessRow?.runtimeTelemetrySource;
    const addPid = (pid: number): boolean => {
      if (pids.includes(pid)) {
        return true;
      }
      if (
        pids.length >= params.limits.maxPidsPerRoot ||
        (!scheduledPids.has(pid) && scheduledPids.size >= params.limits.maxPidsPerSnapshot)
      ) {
        truncated = true;
        return false;
      }
      pids.push(pid);
      scheduledPids.add(pid);
      return true;
    };

    if (!addPid(rootPid)) {
      usageTreesByRootPid.set(rootPid, { pids, truncated });
      continue;
    }

    const queue = [...(childrenByParent.get(rootPid) ?? [])];
    const seen = new Set<number>();
    const rootOwners = rootOwnerKeysByPid.get(rootPid);
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row || seen.has(row.pid)) {
        continue;
      }
      seen.add(row.pid);
      if (
        rootProcessSource &&
        row.runtimeTelemetrySource &&
        row.runtimeTelemetrySource !== rootProcessSource
      ) {
        continue;
      }
      const candidateRootOwners = rootOwnerKeysByPid.get(row.pid);
      if (
        row.pid !== rootPid &&
        candidateRootOwners &&
        !haveSameRootOwners(rootOwners, candidateRootOwners)
      ) {
        continue;
      }
      if (!addPid(row.pid)) {
        break;
      }
      queue.push(...(childrenByParent.get(row.pid) ?? []));
    }
    if (queue.length > 0) {
      truncated = true;
    }
    usageTreesByRootPid.set(rootPid, { pids, truncated });
  }

  for (const rootPid of missingRootPids) {
    if (scheduledPids.size >= params.limits.maxPidsPerSnapshot) {
      usageTreesByRootPid.set(rootPid, { pids: [], truncated: true });
      continue;
    }
    scheduledPids.add(rootPid);
    usageTreesByRootPid.set(rootPid, { pids: [rootPid], truncated: false });
  }

  return usageTreesByRootPid;
}

export function buildRuntimeProcessLoadStats(params: {
  rootPid: number | undefined;
  usageStatsByPid: ReadonlyMap<number, RuntimeProcessUsageStats>;
  processTree?: RuntimeUsageProcessTree;
  scope?: TeamAgentRuntimeLoadScope;
}): RuntimeProcessLoadStats | undefined {
  const rootPid =
    typeof params.rootPid === 'number' && Number.isFinite(params.rootPid) && params.rootPid > 0
      ? params.rootPid
      : undefined;
  if (!rootPid) {
    return undefined;
  }

  if (params.processTree && params.processTree.pids.length === 0) {
    return undefined;
  }

  const processPids = params.processTree ? params.processTree.pids : [rootPid];
  const primaryStats = params.usageStatsByPid.get(rootPid);
  let childCpuPercent = 0;
  let childRssBytes = 0;
  let hasChildCpu = false;
  let hasChildRss = false;
  let sampledProcessCount = primaryStats ? 1 : 0;

  for (const pid of processPids) {
    if (pid === rootPid) {
      continue;
    }
    const childStats = params.usageStatsByPid.get(pid);
    if (!childStats) {
      continue;
    }
    sampledProcessCount += 1;
    if (typeof childStats.cpuPercent === 'number') {
      childCpuPercent += childStats.cpuPercent;
      hasChildCpu = true;
    }
    if (typeof childStats.rssBytes === 'number') {
      childRssBytes += childStats.rssBytes;
      hasChildRss = true;
    }
  }

  if (!primaryStats && sampledProcessCount === 0) {
    return undefined;
  }

  const primaryCpuPercent = primaryStats?.cpuPercent;
  const primaryRssBytes = primaryStats?.rssBytes;
  const cpuPercent =
    primaryCpuPercent != null || hasChildCpu
      ? (primaryCpuPercent ?? 0) + childCpuPercent
      : undefined;
  const rssBytes =
    primaryRssBytes != null || hasChildRss ? (primaryRssBytes ?? 0) + childRssBytes : undefined;
  const hasSampledChildren = hasChildCpu || hasChildRss;
  const hasProcessTree = processPids.length > 1 && hasSampledChildren;
  const runtimeLoadScope =
    params.scope ?? (hasProcessTree ? 'process-tree' : ('single-process' as const));

  return {
    ...(rssBytes != null ? { rssBytes } : {}),
    ...(cpuPercent != null ? { cpuPercent } : {}),
    ...(primaryCpuPercent != null ? { primaryCpuPercent } : {}),
    ...(primaryRssBytes != null ? { primaryRssBytes } : {}),
    ...(hasChildCpu ? { childCpuPercent } : {}),
    ...(hasChildRss ? { childRssBytes } : {}),
    ...(sampledProcessCount > 0 ? { processCount: sampledProcessCount } : {}),
    runtimeLoadScope,
    ...(params.processTree?.truncated ? { runtimeLoadTruncated: true } : {}),
  };
}

export function buildProcessUsageStatsFromRows(
  processRows: readonly RuntimeTelemetryProcessTableRow[] | null,
  pids: readonly number[]
): Map<number, RuntimeProcessUsageStats> {
  const usageStatsByPid = new Map<number, RuntimeProcessUsageStats>();
  const requestedPids = new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0));
  if (!Array.isArray(processRows) || requestedPids.size === 0) {
    return usageStatsByPid;
  }

  for (const row of processRows) {
    if (!requestedPids.has(row.pid)) {
      continue;
    }
    const usageStats = normalizeRuntimeProcessUsageStats(row);
    if (usageStats) {
      usageStatsByPid.set(row.pid, usageStats);
    }
  }
  return usageStatsByPid;
}
