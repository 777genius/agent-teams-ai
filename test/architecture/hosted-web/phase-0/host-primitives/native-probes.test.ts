// @vitest-environment node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const runner = 'scripts/hosted-web/phase-0/host-primitives/run-native-probes.py';
const linuxDescribe = process.platform === 'linux' ? describe : describe.skip;

interface ProbeOutput {
  cleanup: {
    markerRemoved: boolean;
    ownedProcessGroupsTracked: number;
    ownedProcessIdentitiesTracked: number;
    ownedResidualMounts: number;
    ownedResidualProcesses: number;
    performedBeforeEmission: boolean;
  };
  cleanupProbes: {
    actualOwnedResourcesCleanupExecutions: number;
    liveOwnedProcessTerminated: boolean;
    negativeResidualsObserved: number;
    negativeMarkerRemovalRejected: boolean;
    negativeResidualProcessRejected: boolean;
    positiveCleanup: { markerRemoved: boolean; ownedResidualProcesses: number };
  };
  host: { finalShapeContainer: boolean };
  instanceLease: {
    mutualExclusion: boolean;
    outsideEffects: number;
    pathReplacementRejectedByIdentity: boolean;
  };
  processAnchor: {
    controlDescriptorLeaks: number;
    drainDtoGenerationBound: boolean;
    drainDtoKind: string;
    drainDtoSamples: {
      ready: Record<string, unknown>;
      drained: Record<string, unknown>;
      unclassified: Record<string, unknown>;
    };
    numericPgidSignals: number;
    pidfdDescendantSignals: boolean;
    typedStopDrained: boolean;
    typedUnclassified: boolean;
    unrelatedProcessesSignaled: number;
  };
  workspaceGuard: {
    execDescriptorLeaks: number;
    parentSymlinkOutsideEffects: number;
    rawNodeNegativeControlOutsideEffects: number;
    rootRenameOutsideEffects: number;
    staleGenerationOutsideEffects: number;
  };
}

linuxDescribe('Phase 0 W4 native host primitive feasibility probes', () => {
  it('keeps every effect and signal inside a fresh marker-owned fixture', async () => {
    const { stdout } = await execFileAsync('/usr/bin/python3', [runner], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    const result = JSON.parse(stdout) as ProbeOutput;

    expect(result.host.finalShapeContainer).toBe(false);
    expect(result.instanceLease).toMatchObject({
      mutualExclusion: true,
      pathReplacementRejectedByIdentity: true,
      outsideEffects: 0,
    });
    expect(result.workspaceGuard).toMatchObject({
      execDescriptorLeaks: 0,
      parentSymlinkOutsideEffects: 0,
      rootRenameOutsideEffects: 0,
      staleGenerationOutsideEffects: 0,
      rawNodeNegativeControlOutsideEffects: 1,
    });
    expect(result.processAnchor).toMatchObject({
      typedStopDrained: true,
      typedUnclassified: true,
      drainDtoKind: 'process_drain_outcome_v1',
      drainDtoGenerationBound: true,
      numericPgidSignals: 0,
      pidfdDescendantSignals: true,
      controlDescriptorLeaks: 0,
      unrelatedProcessesSignaled: 0,
    });
    expect(result.processAnchor.drainDtoSamples).toEqual({
      ready: {
        protocolVersion: 1,
        spawnNonceHash: 'spawn-nonce-hash-normal-stop',
        purpose: 'host_reset',
        resetGeneration: 7,
        deploymentGeneration: 'deployment-generation-fixture',
        processAnchorGeneration: 'process-anchor-generation-normal',
        anchorIdentity: expect.any(String),
        mainPidfdReady: true,
        ownedProcessGroupReady: true,
      },
      drained: {
        protocolVersion: 1,
        kind: 'process_drain_outcome_v1',
        outcome: 'drained',
        purpose: 'host_reset',
        resetGeneration: 7,
        deploymentGeneration: 'deployment-generation-fixture',
        processAnchorGeneration: 'process-anchor-generation-normal',
        classificationId: expect.any(String),
        residuals: [],
      },
      unclassified: {
        protocolVersion: 1,
        kind: 'process_drain_outcome_v1',
        outcome: 'unclassified',
        purpose: 'host_reset',
        resetGeneration: 7,
        deploymentGeneration: 'deployment-generation-fixture',
        processAnchorGeneration: 'process-anchor-generation-escape',
        classificationId: expect.any(String),
        residuals: ['escaped_group'],
        reason: 'unclassified_identity',
        containerReplacementRequired: true,
      },
    });
    expect(result.cleanupProbes).toMatchObject({
      actualOwnedResourcesCleanupExecutions: 3,
      liveOwnedProcessTerminated: true,
      negativeResidualsObserved: 1,
      negativeMarkerRemovalRejected: true,
      negativeResidualProcessRejected: true,
      positiveCleanup: { markerRemoved: true, ownedResidualProcesses: 0 },
    });
    expect(result.cleanup).toMatchObject({
      performedBeforeEmission: true,
      markerRemoved: true,
      ownedResidualProcesses: 0,
      ownedResidualMounts: 0,
    });
    expect(result.cleanup.ownedProcessIdentitiesTracked).toBeGreaterThan(0);
    expect(result.cleanup.ownedProcessGroupsTracked).toBeGreaterThan(0);
  }, 60_000);
});
