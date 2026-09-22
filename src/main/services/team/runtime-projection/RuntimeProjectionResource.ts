import type {
  RuntimeProjectionResourceEvidence,
  RuntimeProjectionResourceSampleEvidence,
  RuntimeProjectionResourceUsageEvidence,
} from './RuntimeProjectionEvidence';
import type {
  TeamAgentRuntimeLoadScope,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeResourceSample,
} from '@shared/types';

export interface RuntimeProjectionResourceProjection {
  rssBytes?: number;
  cpuPercent?: number;
  primaryRssBytes?: number;
  primaryCpuPercent?: number;
  childRssBytes?: number;
  childCpuPercent?: number;
  processCount?: number;
  runtimeLoadScope?: TeamAgentRuntimeLoadScope;
  runtimeLoadTruncated?: boolean;
  resourceHistory?: TeamAgentRuntimeResourceSample[];
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasUsageValues(usage: RuntimeProjectionResourceUsageEvidence | undefined): boolean {
  return Boolean(
    finiteNonNegative(usage?.rssBytes) != null ||
    finiteNonNegative(usage?.cpuPercent) != null ||
    finiteNonNegative(usage?.primaryRssBytes) != null ||
    finiteNonNegative(usage?.primaryCpuPercent) != null ||
    finiteNonNegative(usage?.childRssBytes) != null ||
    finiteNonNegative(usage?.childCpuPercent) != null ||
    positiveInteger(usage?.processCount)
  );
}

function projectUsageFields(
  usage: RuntimeProjectionResourceUsageEvidence | undefined
): RuntimeProjectionResourceProjection {
  return {
    ...(finiteNonNegative(usage?.rssBytes) != null
      ? { rssBytes: finiteNonNegative(usage?.rssBytes) }
      : {}),
    ...(finiteNonNegative(usage?.cpuPercent) != null
      ? { cpuPercent: finiteNonNegative(usage?.cpuPercent) }
      : {}),
    ...(finiteNonNegative(usage?.primaryRssBytes) != null
      ? { primaryRssBytes: finiteNonNegative(usage?.primaryRssBytes) }
      : {}),
    ...(finiteNonNegative(usage?.primaryCpuPercent) != null
      ? { primaryCpuPercent: finiteNonNegative(usage?.primaryCpuPercent) }
      : {}),
    ...(finiteNonNegative(usage?.childRssBytes) != null
      ? { childRssBytes: finiteNonNegative(usage?.childRssBytes) }
      : {}),
    ...(finiteNonNegative(usage?.childCpuPercent) != null
      ? { childCpuPercent: finiteNonNegative(usage?.childCpuPercent) }
      : {}),
    ...(positiveInteger(usage?.processCount)
      ? { processCount: positiveInteger(usage?.processCount) }
      : {}),
    ...(usage?.runtimeLoadScope ? { runtimeLoadScope: usage.runtimeLoadScope } : {}),
    ...(usage?.runtimeLoadTruncated ? { runtimeLoadTruncated: true } : {}),
  };
}

function projectResourceSample(
  sample: RuntimeProjectionResourceSampleEvidence
): TeamAgentRuntimeResourceSample | undefined {
  const timestamp = sample.timestamp.trim();
  if (!timestamp || !hasUsageValues(sample)) {
    return undefined;
  }
  return {
    timestamp,
    ...projectUsageFields(sample),
    ...(sample.pidSource ? { pidSource: sample.pidSource } : {}),
    ...(positiveInteger(sample.pid) ? { pid: positiveInteger(sample.pid) } : {}),
    ...(positiveInteger(sample.runtimePid)
      ? { runtimePid: positiveInteger(sample.runtimePid) }
      : {}),
  };
}

function normalizeResourceHistory(
  history: readonly RuntimeProjectionResourceSampleEvidence[] | undefined
): TeamAgentRuntimeResourceSample[] {
  return (history ?? []).flatMap((sample) => {
    const projected = projectResourceSample(sample);
    return projected ? [projected] : [];
  });
}

export function projectRuntimeResource(
  evidence: RuntimeProjectionResourceEvidence
): RuntimeProjectionResourceProjection {
  const usagePid = positiveInteger(evidence.pid) ?? positiveInteger(evidence.runtimePid);
  const history = normalizeResourceHistory(evidence.history);
  if (
    !usagePid ||
    evidence.processAlive === false ||
    (!hasUsageValues(evidence.usage) && history.length === 0)
  ) {
    return {};
  }

  return {
    ...projectUsageFields(evidence.usage),
    ...(history.length > 0 ? { resourceHistory: history } : {}),
  };
}

export function projectRuntimeResourceSample(input: {
  timestamp: string;
  pid?: number;
  runtimePid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  usage?: RuntimeProjectionResourceUsageEvidence;
}): TeamAgentRuntimeResourceSample | undefined {
  return projectResourceSample({
    timestamp: input.timestamp,
    ...(input.pid ? { pid: input.pid } : {}),
    ...(input.runtimePid ? { runtimePid: input.runtimePid } : {}),
    ...(input.pidSource ? { pidSource: input.pidSource } : {}),
    ...(input.usage ?? {}),
  });
}
