import type {
  TeamAgentRuntimeLoadScope,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeResourceSample,
} from '@shared/types/team';

export interface TeamAgentRuntimeResourceHistoryOptions {
  historyLimit: number;
  minSampleIntervalMs: number;
}

export interface TeamAgentRuntimeResourceHistoryRecordInput {
  teamName: string;
  memberName: string;
  timestamp: string;
  runId?: string;
  cpuPercent?: number;
  rssBytes?: number;
  primaryCpuPercent?: number;
  primaryRssBytes?: number;
  childCpuPercent?: number;
  childRssBytes?: number;
  processCount?: number;
  runtimeLoadScope?: TeamAgentRuntimeLoadScope;
  runtimeLoadTruncated?: boolean;
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  runtimePid?: number;
  activeKeys?: Set<string>;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

export class TeamAgentRuntimeResourceHistory {
  private readonly historyByTeam = new Map<string, Map<string, TeamAgentRuntimeResourceSample[]>>();

  constructor(private readonly options: TeamAgentRuntimeResourceHistoryOptions) {}

  buildKey(params: {
    memberName: string;
    runId?: string;
    pid?: number;
    runtimePid?: number;
    pidSource?: TeamAgentRuntimePidSource;
  }): string | null {
    const memberName = params.memberName.trim();
    const usagePid = positiveInteger(params.pid) ?? positiveInteger(params.runtimePid);
    if (!memberName || usagePid == null) {
      return null;
    }
    const runId = params.runId?.trim() || 'unknown-run';
    return [runId, memberName, usagePid, params.pidSource ?? 'unknown'].join('\0');
  }

  record(
    params: TeamAgentRuntimeResourceHistoryRecordInput
  ): TeamAgentRuntimeResourceSample[] | undefined {
    const key = this.buildKey(params);
    if (!key) {
      return undefined;
    }
    params.activeKeys?.add(key);

    const cpuPercent = nonNegativeFiniteNumber(params.cpuPercent);
    const rssBytes = nonNegativeFiniteNumber(params.rssBytes);
    const primaryCpuPercent = nonNegativeFiniteNumber(params.primaryCpuPercent);
    const primaryRssBytes = nonNegativeFiniteNumber(params.primaryRssBytes);
    const childCpuPercent = nonNegativeFiniteNumber(params.childCpuPercent);
    const childRssBytes = nonNegativeFiniteNumber(params.childRssBytes);
    const processCount = positiveInteger(params.processCount);
    const pid = positiveInteger(params.pid);
    const runtimePid = positiveInteger(params.runtimePid);
    let historyByKey = this.historyByTeam.get(params.teamName);
    if (!historyByKey) {
      historyByKey = new Map<string, TeamAgentRuntimeResourceSample[]>();
      this.historyByTeam.set(params.teamName, historyByKey);
    }
    const existingHistory = historyByKey.get(key) ?? [];
    if (cpuPercent == null && rssBytes == null) {
      return existingHistory.length > 0
        ? existingHistory.map((sample) => ({ ...sample }))
        : undefined;
    }

    const sample: TeamAgentRuntimeResourceSample = {
      timestamp: params.timestamp,
      ...(cpuPercent != null ? { cpuPercent } : {}),
      ...(rssBytes != null ? { rssBytes } : {}),
      ...(primaryCpuPercent != null ? { primaryCpuPercent } : {}),
      ...(primaryRssBytes != null ? { primaryRssBytes } : {}),
      ...(childCpuPercent != null ? { childCpuPercent } : {}),
      ...(childRssBytes != null ? { childRssBytes } : {}),
      ...(processCount != null ? { processCount } : {}),
      ...(params.runtimeLoadScope ? { runtimeLoadScope: params.runtimeLoadScope } : {}),
      ...(params.runtimeLoadTruncated ? { runtimeLoadTruncated: true } : {}),
      ...(params.pidSource ? { pidSource: params.pidSource } : {}),
      ...(pid != null ? { pid } : {}),
      ...(runtimePid != null ? { runtimePid } : {}),
    };
    const lastSample = existingHistory.at(-1);
    const lastSampleMs = lastSample ? Date.parse(lastSample.timestamp) : Number.NaN;
    const sampleMs = Date.parse(sample.timestamp);
    const sampledRecently =
      Number.isFinite(lastSampleMs) &&
      Number.isFinite(sampleMs) &&
      sampleMs - lastSampleMs >= 0 &&
      sampleMs - lastSampleMs < this.options.minSampleIntervalMs;
    if (sampledRecently) {
      return existingHistory.map((entry) => ({ ...entry }));
    }
    const historyLimit = Number.isFinite(this.options.historyLimit)
      ? Math.max(0, Math.floor(this.options.historyLimit))
      : 0;
    const nextHistory = historyLimit === 0 ? [] : [...existingHistory, sample].slice(-historyLimit);
    historyByKey.set(key, nextHistory);
    return nextHistory.map((entry) => ({ ...entry }));
  }

  prune(teamName: string, activeKeys: ReadonlySet<string>): void {
    const historyByKey = this.historyByTeam.get(teamName);
    if (!historyByKey) {
      return;
    }
    for (const key of historyByKey.keys()) {
      if (!activeKeys.has(key)) {
        historyByKey.delete(key);
      }
    }
    if (historyByKey.size === 0) {
      this.historyByTeam.delete(teamName);
    }
  }
}
