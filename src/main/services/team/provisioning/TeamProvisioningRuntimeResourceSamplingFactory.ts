import { TeamProvisioningRuntimeResourceSampling } from './TeamProvisioningRuntimeResourceSampling';

import type {
  RuntimeResourceSamplingCacheAccess,
  RuntimeResourceSamplingLogPorts,
  RuntimeResourceSamplingOptions,
} from './TeamProvisioningRuntimeResourceSampling';

export const DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS = {
  processTableTimeoutMs: 1_500,
  windowsProcessTableTimeoutMs: 1_500,
  livenessProcessTableCacheTtlMs: 5_000,
  livenessProcessTableFailureCacheTtlMs: 2_000,
  resourceTelemetryCacheTtlMs: 60_000,
  resourceTelemetryFailureCacheTtlMs: 10_000,
  processUsageCacheTtlMs: 30_000,
  processUsageCacheMaxEntries: 4_096,
  pidusageBatchTimeoutMs: 2_000,
  pidusageSingleTimeoutMs: 750,
  pidusageFallbackConcurrency: 16,
  maxRuntimeTreePidsPerRoot: 64,
  maxRuntimeUsagePidsPerSnapshot: 512,
  historyLimit: 60,
  minSampleIntervalMs: 30_000,
} satisfies RuntimeResourceSamplingOptions;

export function createDefaultTeamProvisioningRuntimeResourceSampling(
  cacheAccess: RuntimeResourceSamplingCacheAccess,
  logPorts: RuntimeResourceSamplingLogPorts,
  options: RuntimeResourceSamplingOptions = DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS
): TeamProvisioningRuntimeResourceSampling {
  return new TeamProvisioningRuntimeResourceSampling(options, cacheAccess, logPorts);
}
