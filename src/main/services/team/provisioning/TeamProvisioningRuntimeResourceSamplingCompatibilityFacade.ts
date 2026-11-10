import { TeamProvisioningCompatibilityFacade } from './TeamProvisioningCompatibilityFacade';
import {
  createDefaultTeamProvisioningRuntimeResourceSampling,
  DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS,
} from './TeamProvisioningRuntimeResourceSamplingFactory';

import type { TeamProvisioningCompatibilityDelegationRun } from './TeamProvisioningCompatibilityFacade';
import type {
  RuntimeResourceSamplingCacheAccess,
  RuntimeResourceSamplingLogPorts,
  RuntimeResourceSamplingOptions,
  TeamProvisioningRuntimeResourceSampling,
} from './TeamProvisioningRuntimeResourceSampling';

export interface TeamProvisioningRuntimeResourceSamplingCompatibilityConfig {
  processTableTimeoutMs: number;
  windowsProcessTableTimeoutMs: number;
  pidusageBatchTimeoutMs: number;
  processUsageCacheMaxEntries: number;
}

const runtimeResourceSamplingCompatibilityConfig: TeamProvisioningRuntimeResourceSamplingCompatibilityConfig =
  {
    processTableTimeoutMs: DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.processTableTimeoutMs,
    windowsProcessTableTimeoutMs:
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.windowsProcessTableTimeoutMs,
    pidusageBatchTimeoutMs: DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.pidusageBatchTimeoutMs,
    processUsageCacheMaxEntries:
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.processUsageCacheMaxEntries,
  };

export function createTeamProvisioningRuntimeResourceSamplingOptions(): RuntimeResourceSamplingOptions {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS,
    get processTableTimeoutMs() {
      return runtimeResourceSamplingCompatibilityConfig.processTableTimeoutMs;
    },
    get windowsProcessTableTimeoutMs() {
      return runtimeResourceSamplingCompatibilityConfig.windowsProcessTableTimeoutMs;
    },
    get pidusageBatchTimeoutMs() {
      return runtimeResourceSamplingCompatibilityConfig.pidusageBatchTimeoutMs;
    },
    get processUsageCacheMaxEntries() {
      return runtimeResourceSamplingCompatibilityConfig.processUsageCacheMaxEntries;
    },
  };
}

export function createTeamProvisioningRuntimeResourceSamplingForService(
  cacheAccess: RuntimeResourceSamplingCacheAccess,
  logPorts: RuntimeResourceSamplingLogPorts
): TeamProvisioningRuntimeResourceSampling {
  return createDefaultTeamProvisioningRuntimeResourceSampling(
    cacheAccess,
    logPorts,
    createTeamProvisioningRuntimeResourceSamplingOptions()
  );
}

export abstract class TeamProvisioningRuntimeResourceSamplingCompatibilityFacade<
  TRun extends TeamProvisioningCompatibilityDelegationRun =
    TeamProvisioningCompatibilityDelegationRun,
> extends TeamProvisioningCompatibilityFacade<TRun> {
  static get RUNTIME_PROCESS_TABLE_TIMEOUT_MS(): number {
    return runtimeResourceSamplingCompatibilityConfig.processTableTimeoutMs;
  }

  static set RUNTIME_PROCESS_TABLE_TIMEOUT_MS(value: number) {
    runtimeResourceSamplingCompatibilityConfig.processTableTimeoutMs = value;
  }

  static get RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS(): number {
    return runtimeResourceSamplingCompatibilityConfig.windowsProcessTableTimeoutMs;
  }

  static set RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS(value: number) {
    runtimeResourceSamplingCompatibilityConfig.windowsProcessTableTimeoutMs = value;
  }

  static get RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS(): number {
    return runtimeResourceSamplingCompatibilityConfig.pidusageBatchTimeoutMs;
  }

  static set RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS(value: number) {
    runtimeResourceSamplingCompatibilityConfig.pidusageBatchTimeoutMs = value;
  }

  static get RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES(): number {
    return runtimeResourceSamplingCompatibilityConfig.processUsageCacheMaxEntries;
  }

  static set RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES(value: number) {
    runtimeResourceSamplingCompatibilityConfig.processUsageCacheMaxEntries = value;
  }

  protected get liveTeamAgentRuntimeMetadataCache(): Map<string, unknown> {
    return (
      this as unknown as {
        runtimeResourceCacheBoundary: { liveTeamAgentRuntimeMetadataCache: Map<string, unknown> };
      }
    ).runtimeResourceCacheBoundary.liveTeamAgentRuntimeMetadataCache;
  }
}
