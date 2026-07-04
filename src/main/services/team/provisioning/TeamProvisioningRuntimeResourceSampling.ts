import {
  listRuntimeProcessTableForCurrentPlatform,
  type RuntimeProcessTableRow,
} from '@features/tmux-installer/main';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import pidusage from 'pidusage';

import { TeamAgentRuntimeResourceHistory } from '../TeamAgentRuntimeResourceHistory';
import {
  buildRuntimeProcessLoadStats,
  buildRuntimeUsageProcessTrees,
  isRuntimePidusageTelemetryEnabled,
  normalizeRuntimeProcessRowsForTelemetry,
  normalizeRuntimeProcessUsageStats,
  type RuntimeProcessLoadStats,
  type RuntimeProcessUsageStats,
  type RuntimeTelemetryProcessTableRow,
  RuntimeTelemetryTimeoutError,
  type RuntimeUsageProcessTree,
  withRuntimeTelemetryTimeout,
} from '../TeamRuntimeTelemetry';

import {
  readCachedRuntimeProcessRowsForLiveRuntimeMetadata,
  type RuntimeProcessRowsCacheEntry,
} from './TeamProvisioningRuntimeMetadataPolicy';

import type { TeamAgentRuntimeResourceHistoryRecordInput } from '../TeamAgentRuntimeResourceHistory';
import type { TeamAgentRuntimeResourceSample } from '@shared/types/team';

const runtimePidusageOptions = process.platform === 'win32' ? { maxage: 10_000 } : { maxage: 0 };

export interface RuntimeProcessUsageStatsCacheEntry {
  expiresAtMs: number;
  stats: RuntimeProcessUsageStats | null;
}

export interface RuntimeResourceSamplingCacheAccess {
  getRuntimeSnapshotCacheGeneration(teamName: string): number;
  getTrackedRunId(teamName: string): string | null;
}

export interface RuntimeResourceSamplingLogPorts {
  logDebug(message: string): void;
}

export interface RuntimeResourceSamplingOptions {
  processTableTimeoutMs: number;
  windowsProcessTableTimeoutMs: number;
  livenessProcessTableCacheTtlMs: number;
  livenessProcessTableFailureCacheTtlMs: number;
  resourceTelemetryCacheTtlMs: number;
  resourceTelemetryFailureCacheTtlMs: number;
  processUsageCacheTtlMs: number;
  processUsageCacheMaxEntries: number;
  pidusageBatchTimeoutMs: number;
  pidusageSingleTimeoutMs: number;
  pidusageFallbackConcurrency: number;
  maxRuntimeTreePidsPerRoot: number;
  maxRuntimeUsagePidsPerSnapshot: number;
  historyLimit: number;
  minSampleIntervalMs: number;
}

export interface RuntimeProcessRowsReadResult {
  rows: RuntimeTelemetryProcessTableRow[];
  processTableAvailable: boolean;
}

export interface RuntimeResourceSamplingProcessReaders {
  listRuntimeProcessTable(): Promise<unknown>;
  listWindowsProcessTable(timeoutMs: number): Promise<unknown>;
}

export interface RuntimeResourceSamplingPidUsageReader {
  read(pids: number | readonly number[], options?: { maxage?: number }): Promise<unknown>;
}

export interface TeamProvisioningRuntimeSnapshotResourceSamplingPorts {
  readRuntimeProcessRowsForUsageSnapshot(
    teamName: string,
    options?: { includeWindowsHostRows?: boolean }
  ): Promise<RuntimeTelemetryProcessTableRow[] | null>;
  readProcessUsageStatsByPid(
    pids: readonly number[],
    cacheOptions?: { ignoreCachedMisses?: boolean }
  ): Promise<Map<number, RuntimeProcessUsageStats>>;
  buildRuntimeUsageProcessTrees(input: {
    rootPids: readonly number[];
    processRows: readonly RuntimeTelemetryProcessTableRow[] | null;
    rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>;
  }): Map<number, RuntimeUsageProcessTree>;
  buildRuntimeProcessLoadStats(
    input: Parameters<typeof buildRuntimeProcessLoadStats>[0]
  ): RuntimeProcessLoadStats | undefined;
  agentRuntimeResourceHistory: {
    record(
      params: TeamAgentRuntimeResourceHistoryRecordInput
    ): TeamAgentRuntimeResourceSample[] | undefined;
    prune(teamName: string, activeKeys: ReadonlySet<string>): void;
  };
}

export class TeamProvisioningRuntimeResourceSampling {
  private readonly runtimeProcessRowsForUsageSnapshotByTeam = new Map<
    string,
    RuntimeProcessRowsCacheEntry
  >();

  private readonly runtimeProcessUsageStatsCacheByPid = new Map<
    number,
    RuntimeProcessUsageStatsCacheEntry
  >();

  private readonly agentRuntimeResourceHistory: TeamAgentRuntimeResourceHistory;

  readonly agentRuntimeResourceHistoryPort = {
    record: (
      params: TeamAgentRuntimeResourceHistoryRecordInput
    ): TeamAgentRuntimeResourceSample[] | undefined =>
      this.recordAgentRuntimeResourceSample(params),
    prune: (teamName: string, activeKeys: ReadonlySet<string>): void =>
      this.pruneAgentRuntimeResourceHistory(teamName, activeKeys),
  };

  constructor(
    private readonly options: RuntimeResourceSamplingOptions,
    private readonly cacheAccess: RuntimeResourceSamplingCacheAccess,
    private readonly logPorts: RuntimeResourceSamplingLogPorts,
    private readonly processReaders: RuntimeResourceSamplingProcessReaders = {
      listRuntimeProcessTable: listRuntimeProcessTableForCurrentPlatform,
      listWindowsProcessTable,
    },
    private readonly pidUsageReader: RuntimeResourceSamplingPidUsageReader = {
      read: (pids, options) => {
        if (typeof pids === 'number') {
          return pidusage(pids, options);
        }
        return pidusage([...pids], options);
      },
    }
  ) {
    this.agentRuntimeResourceHistory = new TeamAgentRuntimeResourceHistory({
      historyLimit: options.historyLimit,
      minSampleIntervalMs: options.minSampleIntervalMs,
    });
  }

  clearRuntimeProcessRowsForTeam(teamName: string): void {
    this.runtimeProcessRowsForUsageSnapshotByTeam.delete(teamName);
  }

  getRuntimeProcessRowsCache(): Map<string, RuntimeProcessRowsCacheEntry> {
    return this.runtimeProcessRowsForUsageSnapshotByTeam;
  }

  createRuntimeSnapshotResourceSamplingPorts(): TeamProvisioningRuntimeSnapshotResourceSamplingPorts {
    return {
      readRuntimeProcessRowsForUsageSnapshot: (teamName, options) =>
        this.readRuntimeProcessRowsForUsageSnapshot(teamName, options),
      readProcessUsageStatsByPid: (pids, cacheOptions) =>
        this.readProcessUsageStatsByPid(pids, cacheOptions),
      buildRuntimeUsageProcessTrees: (input) => this.buildRuntimeUsageProcessTrees(input),
      buildRuntimeProcessLoadStats: (input) => this.buildRuntimeProcessLoadStats(input),
      agentRuntimeResourceHistory: this.agentRuntimeResourceHistoryPort,
    };
  }

  readCachedRuntimeProcessRowsForLiveRuntimeMetadata(
    teamName: string,
    runId: string | null
  ): ReturnType<typeof readCachedRuntimeProcessRowsForLiveRuntimeMetadata> {
    return readCachedRuntimeProcessRowsForLiveRuntimeMetadata({
      cached: this.runtimeProcessRowsForUsageSnapshotByTeam.get(teamName),
      runId,
      nowMs: Date.now(),
      processTableCacheTtlMs: this.options.livenessProcessTableCacheTtlMs,
      processTableFailureCacheTtlMs: this.options.livenessProcessTableFailureCacheTtlMs,
    });
  }

  async readRuntimeProcessRowsForLiveRuntimeMetadata(params: {
    teamName: string;
    runId: string | null;
    generationAtStart: number;
  }): Promise<RuntimeProcessRowsReadResult> {
    const cachedRows = this.readCachedRuntimeProcessRowsForLiveRuntimeMetadata(
      params.teamName,
      params.runId
    );
    if (cachedRows) {
      return {
        processTableAvailable: cachedRows.rows !== null,
        rows: cachedRows.rows ?? [],
      };
    }

    let processRows: RuntimeTelemetryProcessTableRow[] = [];
    let processTableAvailable = true;
    try {
      processRows =
        normalizeRuntimeProcessRowsForTelemetry(
          await withRuntimeTelemetryTimeout(
            this.processReaders.listRuntimeProcessTable(),
            this.options.processTableTimeoutMs,
            'process table runtime snapshot'
          ),
          process.platform === 'win32' ? 'wsl' : 'native'
        ) ?? [];
    } catch (error) {
      processTableAvailable = false;
      this.logPorts.logDebug(
        `[${params.teamName}] Failed to read process table for runtime snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      this.cacheAccess.getRuntimeSnapshotCacheGeneration(params.teamName) ===
      params.generationAtStart
    ) {
      this.rememberRuntimeProcessRows(params.teamName, {
        generation: params.generationAtStart,
        runId: params.runId,
        rows: processTableAvailable ? processRows : null,
        includesWindowsHostRows: false,
      });
    }

    return { rows: processRows, processTableAvailable };
  }

  async readWindowsHostProcessRowsForLiveRuntimeMetadata(
    teamName: string
  ): Promise<RuntimeProcessRowsReadResult> {
    try {
      const rows =
        normalizeRuntimeProcessRowsForTelemetry(
          await withRuntimeTelemetryTimeout(
            this.processReaders.listWindowsProcessTable(this.options.windowsProcessTableTimeoutMs),
            this.options.windowsProcessTableTimeoutMs,
            'Windows process table runtime snapshot'
          ),
          'windows-host'
        ) ?? [];
      return { rows, processTableAvailable: true };
    } catch (error) {
      this.logPorts.logDebug(
        `[${teamName}] Failed to read Windows host process table for runtime snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { rows: [], processTableAvailable: false };
    }
  }

  async readRuntimeProcessRowsForUsageSnapshot(
    teamName: string,
    options: { includeWindowsHostRows?: boolean } = {}
  ): Promise<RuntimeTelemetryProcessTableRow[] | null> {
    const includeWindowsHostRows =
      process.platform === 'win32' && options.includeWindowsHostRows === true;
    const cached = this.runtimeProcessRowsForUsageSnapshotByTeam.get(teamName);
    const canUseCached =
      cached &&
      cached.expiresAtMs > Date.now() &&
      cached.runId === this.cacheAccess.getTrackedRunId(teamName);
    if (canUseCached && (!includeWindowsHostRows || cached.includesWindowsHostRows)) {
      return cached.rows;
    }

    let rows = canUseCached && cached.rows ? cached.rows : null;
    let runtimeProcessTableAvailable = rows != null;
    try {
      if (!rows) {
        rows =
          normalizeRuntimeProcessRowsForTelemetry(
            await withRuntimeTelemetryTimeout(
              this.processReaders.listRuntimeProcessTable(),
              this.options.processTableTimeoutMs,
              'process table runtime telemetry'
            ),
            process.platform === 'win32' ? 'wsl' : 'native'
          ) ?? [];
        runtimeProcessTableAvailable = true;
      }
    } catch (error) {
      this.logPorts.logDebug(
        `[${teamName}] Failed to read process table for runtime usage snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      rows = null;
      runtimeProcessTableAvailable = false;
    }

    let includesWindowsHostRows = false;
    if (includeWindowsHostRows) {
      try {
        const windowsHostRows = await withRuntimeTelemetryTimeout(
          this.processReaders.listWindowsProcessTable(this.options.windowsProcessTableTimeoutMs),
          this.options.windowsProcessTableTimeoutMs,
          'Windows process table runtime telemetry'
        );
        rows = [
          ...(rows ?? []),
          ...(normalizeRuntimeProcessRowsForTelemetry(windowsHostRows, 'windows-host') ?? []),
        ];
        includesWindowsHostRows = true;
      } catch (error) {
        this.logPorts.logDebug(
          `[${teamName}] Failed to read Windows host process table for runtime usage snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const resultRows = rows && rows.length > 0 ? rows : runtimeProcessTableAvailable ? [] : null;
    this.rememberRuntimeProcessRows(teamName, {
      generation: this.cacheAccess.getRuntimeSnapshotCacheGeneration(teamName),
      runId: this.cacheAccess.getTrackedRunId(teamName),
      rows: resultRows,
      includesWindowsHostRows,
    });
    return resultRows;
  }

  async readProcessUsageStatsByPid(
    pids: readonly number[],
    cacheOptions: { ignoreCachedMisses?: boolean } = {}
  ): Promise<Map<number, RuntimeProcessUsageStats>> {
    const pidCandidates = Array.isArray(pids) ? pids : [];
    const uniquePids = [...new Set(pidCandidates.filter((pid) => Number.isFinite(pid) && pid > 0))];
    if (uniquePids.length === 0) {
      return new Map();
    }

    const usageStatsByPid = new Map<number, RuntimeProcessUsageStats>();
    const pidsToRead: number[] = [];
    const now = Date.now();
    for (const pid of uniquePids) {
      const cached = this.runtimeProcessUsageStatsCacheByPid.get(pid);
      if (cached && cached.expiresAtMs > now) {
        if (cached.stats) {
          usageStatsByPid.set(pid, { ...cached.stats });
          continue;
        }
        if (!cacheOptions.ignoreCachedMisses) {
          continue;
        }
      }
      if (cached) {
        this.runtimeProcessUsageStatsCacheByPid.delete(pid);
      }
      pidsToRead.push(pid);
    }
    if (pidsToRead.length === 0) {
      return usageStatsByPid;
    }
    if (!isRuntimePidusageTelemetryEnabled()) {
      return usageStatsByPid;
    }

    const rememberUsageStats = (
      pid: number,
      stats: RuntimeProcessUsageStats | null | undefined
    ): void => {
      const normalized = stats ? { ...stats } : null;
      const nowMs = Date.now();
      for (const [cachedPid, cached] of this.runtimeProcessUsageStatsCacheByPid) {
        if (cached.expiresAtMs <= nowMs) {
          this.runtimeProcessUsageStatsCacheByPid.delete(cachedPid);
        }
      }
      while (
        !this.runtimeProcessUsageStatsCacheByPid.has(pid) &&
        this.runtimeProcessUsageStatsCacheByPid.size >= this.options.processUsageCacheMaxEntries
      ) {
        const oldestPid = this.runtimeProcessUsageStatsCacheByPid.keys().next().value;
        if (oldestPid == null) {
          break;
        }
        this.runtimeProcessUsageStatsCacheByPid.delete(oldestPid);
      }
      this.runtimeProcessUsageStatsCacheByPid.set(pid, {
        expiresAtMs: nowMs + this.options.processUsageCacheTtlMs,
        stats: normalized,
      });
      if (normalized) {
        usageStatsByPid.set(pid, { ...normalized });
      }
    };

    try {
      const statsByPid = await withRuntimeTelemetryTimeout(
        this.pidUsageReader.read(pidsToRead, runtimePidusageOptions),
        this.options.pidusageBatchTimeoutMs,
        'pidusage batch runtime telemetry'
      );
      const observedPids = new Set<number>();
      for (const [rawPid, stat] of Object.entries(
        statsByPid && typeof statsByPid === 'object' ? statsByPid : {}
      )) {
        const pid = Number.parseInt(rawPid, 10);
        const usageStats = normalizeRuntimeProcessUsageStats(stat);
        if (Number.isFinite(pid) && pid > 0) {
          observedPids.add(pid);
          rememberUsageStats(pid, usageStats);
        }
      }
      for (const pid of pidsToRead) {
        if (!observedPids.has(pid)) {
          rememberUsageStats(pid, null);
        }
      }
      return usageStatsByPid;
    } catch (error) {
      if (error instanceof RuntimeTelemetryTimeoutError) {
        this.logPorts.logDebug(`${error.message}; continuing without runtime resource metrics`);
        return usageStatsByPid;
      }
      this.logPorts.logDebug(
        `pidusage batch runtime snapshot failed; falling back to per-pid reads: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    for (
      let offset = 0;
      offset < pidsToRead.length;
      offset += this.options.pidusageFallbackConcurrency
    ) {
      const chunk = pidsToRead.slice(offset, offset + this.options.pidusageFallbackConcurrency);
      await Promise.all(
        chunk.map(async (pid) => {
          try {
            const stat = await withRuntimeTelemetryTimeout(
              this.pidUsageReader.read(pid, runtimePidusageOptions),
              this.options.pidusageSingleTimeoutMs,
              `pidusage runtime telemetry pid=${pid}`
            );
            const usageStats = normalizeRuntimeProcessUsageStats(stat);
            rememberUsageStats(pid, usageStats);
          } catch (error) {
            if (error instanceof RuntimeTelemetryTimeoutError) {
              this.logPorts.logDebug(error.message);
            }
            rememberUsageStats(pid, null);
          }
        })
      );
    }
    return usageStatsByPid;
  }

  buildRuntimeUsageProcessTrees(
    input:
      | {
          rootPids: readonly number[];
          processRows: readonly RuntimeTelemetryProcessTableRow[] | null;
          rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>;
        }
      | readonly number[],
    processRows?: readonly RuntimeTelemetryProcessTableRow[] | null,
    rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>
  ): Map<number, RuntimeUsageProcessTree> {
    type RuntimeUsageProcessTreeInputObject = {
      rootPids: readonly number[];
      processRows: readonly RuntimeTelemetryProcessTableRow[] | null;
      rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>;
    };
    const treeInput: RuntimeUsageProcessTreeInputObject = Array.isArray(input)
      ? {
          rootPids: input as readonly number[],
          processRows: processRows ?? null,
          rootOwnersByPid,
        }
      : (input as RuntimeUsageProcessTreeInputObject);
    return buildRuntimeUsageProcessTrees({
      ...treeInput,
      limits: {
        maxPidsPerRoot: this.options.maxRuntimeTreePidsPerRoot,
        maxPidsPerSnapshot: this.options.maxRuntimeUsagePidsPerSnapshot,
      },
      platform: process.platform,
    });
  }

  buildRuntimeProcessLoadStats(
    input: Parameters<typeof buildRuntimeProcessLoadStats>[0]
  ): RuntimeProcessLoadStats | undefined {
    return buildRuntimeProcessLoadStats(input);
  }

  recordAgentRuntimeResourceSample(
    input: TeamAgentRuntimeResourceHistoryRecordInput
  ): TeamAgentRuntimeResourceSample[] | undefined {
    return this.agentRuntimeResourceHistory.record(input);
  }

  pruneAgentRuntimeResourceHistory(teamName: string, activeKeys: ReadonlySet<string>): void {
    this.agentRuntimeResourceHistory.prune(teamName, activeKeys);
  }

  private rememberRuntimeProcessRows(
    teamName: string,
    input: {
      generation: number;
      runId: string | null;
      rows: RuntimeProcessTableRow[] | RuntimeTelemetryProcessTableRow[] | null;
      includesWindowsHostRows: boolean;
    }
  ): void {
    const sampledAtMs = Date.now();
    this.runtimeProcessRowsForUsageSnapshotByTeam.set(teamName, {
      expiresAtMs:
        sampledAtMs +
        (input.rows === null
          ? this.options.resourceTelemetryFailureCacheTtlMs
          : this.options.resourceTelemetryCacheTtlMs),
      generation: input.generation,
      runId: input.runId,
      sampledAtMs,
      rows: input.rows,
      includesWindowsHostRows: input.includesWindowsHostRows,
    });
  }
}
