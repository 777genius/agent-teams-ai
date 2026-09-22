import { describe, expect, it } from 'vitest';

import {
  createTeamProvisioningRuntimeResourceSamplingOptions,
  TeamProvisioningRuntimeResourceSamplingCompatibilityFacade,
} from '../TeamProvisioningRuntimeResourceSamplingCompatibilityFacade';
import { DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS } from '../TeamProvisioningRuntimeResourceSamplingFactory';

import type {
  TeamProvisioningCompatibilityDelegation,
  TeamProvisioningCompatibilityDelegationRun,
} from '../TeamProvisioningCompatibilityFacade';

class TestRuntimeResourceSamplingCompatibilityFacade extends TeamProvisioningRuntimeResourceSamplingCompatibilityFacade {
  protected readonly compatibilityDelegation =
    {} as TeamProvisioningCompatibilityDelegation<TeamProvisioningCompatibilityDelegationRun>;
}

function snapshotStaticConfig() {
  return {
    processTableTimeoutMs:
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_TABLE_TIMEOUT_MS,
    windowsProcessTableTimeoutMs:
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS,
    pidusageBatchTimeoutMs:
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS,
    processUsageCacheMaxEntries:
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES,
  };
}

function restoreStaticConfig(config: ReturnType<typeof snapshotStaticConfig>): void {
  TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_TABLE_TIMEOUT_MS =
    config.processTableTimeoutMs;
  TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS =
    config.windowsProcessTableTimeoutMs;
  TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS =
    config.pidusageBatchTimeoutMs;
  TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES =
    config.processUsageCacheMaxEntries;
}

describe('TeamProvisioningRuntimeResourceSamplingCompatibilityFacade', () => {
  it('keeps runtime resource sampling compatibility defaults aligned with factory defaults', () => {
    const options = createTeamProvisioningRuntimeResourceSamplingOptions();

    expect(options.processTableTimeoutMs).toBe(
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.processTableTimeoutMs
    );
    expect(options.windowsProcessTableTimeoutMs).toBe(
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.windowsProcessTableTimeoutMs
    );
    expect(options.pidusageBatchTimeoutMs).toBe(
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.pidusageBatchTimeoutMs
    );
    expect(options.processUsageCacheMaxEntries).toBe(
      DEFAULT_RUNTIME_RESOURCE_SAMPLING_OPTIONS.processUsageCacheMaxEntries
    );
  });

  it('preserves mutable static timeout compatibility as live sampling options', () => {
    const originalConfig = snapshotStaticConfig();
    const options = createTeamProvisioningRuntimeResourceSamplingOptions();

    try {
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_TABLE_TIMEOUT_MS = 11;
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS = 12;
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS = 13;
      TestRuntimeResourceSamplingCompatibilityFacade.RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES = 14;

      expect(options.processTableTimeoutMs).toBe(11);
      expect(options.windowsProcessTableTimeoutMs).toBe(12);
      expect(options.pidusageBatchTimeoutMs).toBe(13);
      expect(options.processUsageCacheMaxEntries).toBe(14);
    } finally {
      restoreStaticConfig(originalConfig);
    }
  });
});
