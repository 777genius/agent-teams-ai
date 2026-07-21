// @vitest-environment node

import {
  InstanceLeaseGuard,
  type InstanceLeaseLauncherEvidence,
  type VerifiedInstanceLeaseHandle,
} from '@features/instance-lease';
import {
  createMutationReadinessAssessor,
  type ExternalWriterReadinessDiagnosticCode,
  type FilesystemReadinessDiagnosticCode,
  type InstanceLeaseReadinessEvidencePort,
  MAX_MUTATION_READINESS_ASSESSMENT_TIMEOUT_MS,
  type MutationReadinessAssessor,
  type MutationReadinessDecisionStatus,
  type MutationReadinessDimension,
  type MutationReadinessEvidencePorts,
  type MutationReadinessWorkspaceTarget,
  type ReadinessEvidenceInspection,
  type RecoveryOutboxReadinessDiagnosticCode,
  type RuntimeBindingReadinessDiagnosticCode,
  type StorageReadinessDiagnosticCode,
  type VerifiedExternalWriterReadinessEvidence,
  type VerifiedFilesystemReadinessEvidence,
  type VerifiedRecoveryOutboxReadinessEvidence,
  type VerifiedRuntimeBindingReadinessEvidence,
  type VerifiedStorageReadinessEvidence,
  type VerifiedWorkspaceBindingReadinessEvidence,
  type WorkspaceBindingReadinessDiagnosticCode,
} from '@features/mutation-readiness';
import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
} from '@features/runtime-instance-context';
import { parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const NOW_MS = 10_000;
const STORAGE_SCHEMA_VERSION = 9;
const MINIMUM_FREE_BYTES = 1_024;
const EVIDENCE_MAX_AGE_MS = 1_000;
const EVALUATION_TIMEOUT_MS = 100;

interface MutableLeaseHandle extends VerifiedInstanceLeaseHandle {
  valid: boolean;
  closed: boolean;
}

interface FixtureInspections {
  runtimeBinding: ReadinessEvidenceInspection<VerifiedRuntimeBindingReadinessEvidence>;
  workspaceBinding: ReadinessEvidenceInspection<VerifiedWorkspaceBindingReadinessEvidence>;
  storage: ReadinessEvidenceInspection<VerifiedStorageReadinessEvidence>;
  filesystem: ReadinessEvidenceInspection<VerifiedFilesystemReadinessEvidence>;
  externalWriter: ReadinessEvidenceInspection<VerifiedExternalWriterReadinessEvidence>;
  recoveryOutbox: ReadinessEvidenceInspection<VerifiedRecoveryOutboxReadinessEvidence>;
}

interface ReadinessFixture {
  runtimeInstance: RuntimeInstanceContext;
  workspace: MutationReadinessWorkspaceTarget;
  leaseEvidence: InstanceLeaseLauncherEvidence;
  leaseHandle: MutableLeaseHandle;
  leaseGuard: InstanceLeaseGuard;
  evidence: {
    runtimeBinding: VerifiedRuntimeBindingReadinessEvidence;
    workspaceBinding: VerifiedWorkspaceBindingReadinessEvidence;
    storage: VerifiedStorageReadinessEvidence;
    filesystem: VerifiedFilesystemReadinessEvidence;
    externalWriter: VerifiedExternalWriterReadinessEvidence;
    recoveryOutbox: VerifiedRecoveryOutboxReadinessEvidence;
  };
  inspections: FixtureInspections;
  createAssessor(
    evidenceOverrides?: MutationReadinessEvidencePorts,
    instanceLease?: InstanceLeaseReadinessEvidencePort | null
  ): MutationReadinessAssessor;
}

function verified<TEvidence>(
  evidence: TEvidence,
  checkedAtMs = NOW_MS
): ReadinessEvidenceInspection<TEvidence> {
  return { status: 'verified', checkedAtMs, evidence };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFixture(fill: '1' | '2' = '1'): ReadinessFixture {
  const suffix = fill === '1' ? 'primary' : 'secondary';
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: `deployment_mutation-readiness-${suffix}`,
    bootId: `boot_mutation-readiness-${suffix}`,
    claudeRoot: { kind: 'claude', reference: `runtime://${suffix}/claude` },
    appDataRoot: { kind: 'app-data', reference: `runtime://${suffix}/app-data` },
    workspaceRoots: [{ kind: 'workspace', reference: `runtime://${suffix}/workspace` }],
    tempRoot: { kind: 'temp', reference: `runtime://${suffix}/temp` },
    logsRoot: { kind: 'logs', reference: `runtime://${suffix}/logs` },
  });
  const workspace: MutationReadinessWorkspaceTarget = {
    binding: {
      workspaceId: parseWorkspaceId(`workspace_${fill.repeat(32)}`),
      bootId: runtimeInstance.bootId,
      mountGeneration: fill === '1' ? 4 : 7,
    },
    rootReference: runtimeInstance.workspaceRoots[0],
    declaredRootHash: fill.repeat(64),
    registrationRevision: fill === '1' ? 6 : 8,
  };
  const leaseEvidence: InstanceLeaseLauncherEvidence = {
    protocolVersion: 1,
    launcherPid: fill === '1' ? 100 : 200,
    controllerPid: fill === '1' ? 101 : 201,
    anchor: {
      device: fill === '1' ? '8' : '9',
      inode: fill === '1' ? '42' : '84',
      mode: 0o100644,
      uid: 0,
      linkCount: 1,
    },
  };
  const leaseHandle: MutableLeaseHandle = {
    evidence: leaseEvidence,
    valid: true,
    closed: false,
    assertValid() {
      if (!this.valid || this.closed) throw new Error('lease fixture invalid');
    },
    close() {
      this.closed = true;
    },
  };
  const leaseGuard = InstanceLeaseGuard.takeOwnership(leaseHandle);
  const evidence = {
    runtimeBinding: {
      runtimeInstance,
      leaseAnchor: leaseEvidence.anchor,
    } satisfies VerifiedRuntimeBindingReadinessEvidence,
    workspaceBinding: {
      ...workspace,
      health: 'healthy',
    } satisfies VerifiedWorkspaceBindingReadinessEvidence,
    storage: {
      deploymentId: runtimeInstance.deploymentId,
      appDataRootReference: runtimeInstance.appDataRoot.reference,
      backend: 'sqlite',
      compatibility: 'verified',
      schemaVersion: STORAGE_SCHEMA_VERSION,
      migrationState: 'complete',
      integrity: 'ok',
      criticalFallback: 'disabled',
    } satisfies VerifiedStorageReadinessEvidence,
    filesystem: {
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      workspaceBinding: workspace.binding,
      rootReference: workspace.rootReference,
      filesystem: 'supported',
      permission: 'read_write',
      freeBytes: MINIMUM_FREE_BYTES * 2,
      atomicReplace: 'verified',
      directoryDurability: 'verified',
    } satisfies VerifiedFilesystemReadinessEvidence,
    externalWriter: {
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      workspaceBinding: workspace.binding,
      classification: 'app_exclusive',
      coordination: 'lease_fenced',
      observation: 'clean',
      fileWriterEpoch: 3,
      observationWatermark: 12,
    } satisfies VerifiedExternalWriterReadinessEvidence,
    recoveryOutbox: {
      deploymentId: runtimeInstance.deploymentId,
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      scanState: 'complete',
      recoveryState: 'complete',
      outboxState: 'ready',
      pendingCommandCount: 0,
      recoveringCommandCount: 0,
      operatorRequiredCount: 0,
      unknownRecordCount: 0,
    } satisfies VerifiedRecoveryOutboxReadinessEvidence,
  };
  const inspections: FixtureInspections = {
    runtimeBinding: verified(evidence.runtimeBinding),
    workspaceBinding: verified(evidence.workspaceBinding),
    storage: verified(evidence.storage),
    filesystem: verified(evidence.filesystem),
    externalWriter: verified(evidence.externalWriter),
    recoveryOutbox: verified(evidence.recoveryOutbox),
  };
  const fixture: ReadinessFixture = {
    runtimeInstance,
    workspace,
    leaseEvidence,
    leaseHandle,
    leaseGuard,
    evidence,
    inspections,
    createAssessor(evidenceOverrides = {}, instanceLease = fixture.leaseGuard) {
      const defaultEvidence: MutationReadinessEvidencePorts = {
        runtimeBinding: {
          inspectRuntimeBinding: () => fixture.inspections.runtimeBinding,
        },
        workspaceBinding: {
          inspectWorkspaceBinding: () => fixture.inspections.workspaceBinding,
        },
        storage: {
          inspectStorageReadiness: () => fixture.inspections.storage,
        },
        filesystem: {
          inspectFilesystemReadiness: () => fixture.inspections.filesystem,
        },
        externalWriter: {
          inspectExternalWriterReadiness: () => fixture.inspections.externalWriter,
        },
        recoveryOutbox: {
          inspectRecoveryOutboxReadiness: () => fixture.inspections.recoveryOutbox,
        },
      };
      return createMutationReadinessAssessor({
        instanceLease,
        runtimeInstance: fixture.runtimeInstance,
        workspace: fixture.workspace,
        requirements: {
          storageSchemaVersion: STORAGE_SCHEMA_VERSION,
          minimumFreeBytes: MINIMUM_FREE_BYTES,
          evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS,
          evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
        },
        clock: { nowMs: () => NOW_MS },
        evidence: { ...defaultEvidence, ...evidenceOverrides },
      });
    },
  };
  return fixture;
}

function replaceInspection(
  fixture: ReadinessFixture,
  dimension: Exclude<MutationReadinessDimension, 'instanceLease'>,
  inspection: { readonly status: 'unavailable' | 'unknown' }
): void {
  switch (dimension) {
    case 'runtimeBinding':
      fixture.inspections.runtimeBinding = inspection;
      break;
    case 'workspaceBinding':
      fixture.inspections.workspaceBinding = inspection;
      break;
    case 'storage':
      fixture.inspections.storage = inspection;
      break;
    case 'filesystem':
      fixture.inspections.filesystem = inspection;
      break;
    case 'externalWriter':
      fixture.inspections.externalWriter = inspection;
      break;
    case 'recoveryOutbox':
      fixture.inspections.recoveryOutbox = inspection;
      break;
  }
}

function makeStale(
  fixture: ReadinessFixture,
  dimension: Exclude<MutationReadinessDimension, 'instanceLease'>
): void {
  const staleAt = NOW_MS - EVIDENCE_MAX_AGE_MS - 1;
  switch (dimension) {
    case 'runtimeBinding':
      fixture.inspections.runtimeBinding = verified(fixture.evidence.runtimeBinding, staleAt);
      break;
    case 'workspaceBinding':
      fixture.inspections.workspaceBinding = verified(fixture.evidence.workspaceBinding, staleAt);
      break;
    case 'storage':
      fixture.inspections.storage = verified(fixture.evidence.storage, staleAt);
      break;
    case 'filesystem':
      fixture.inspections.filesystem = verified(fixture.evidence.filesystem, staleAt);
      break;
    case 'externalWriter':
      fixture.inspections.externalWriter = verified(fixture.evidence.externalWriter, staleAt);
      break;
    case 'recoveryOutbox':
      fixture.inspections.recoveryOutbox = verified(fixture.evidence.recoveryOutbox, staleAt);
      break;
  }
}

describe('Mutation readiness', () => {
  it('reports a fully verified fixture without exposing reusable mutation authority', async () => {
    const assessor = createFixture().createAssessor();

    const result = await assessor.assess();

    expect(assessor.authoritativeForMutation).toBe(false);
    expect(result).toMatchObject({
      kind: 'mutation_readiness_diagnostic',
      assessment: 'all_evidence_verified',
      authoritativeForMutation: false,
      diagnosticCodes: [
        'instance_lease_held',
        'runtime_binding_verified',
        'workspace_binding_verified',
        'storage_ready',
        'filesystem_ready',
        'external_writer_coordinated',
        'recovery_outbox_ready',
      ],
    });
    expect(
      Object.values(result.decisions).every(
        (value) => value.status === ('verified' satisfies MutationReadinessDecisionStatus)
      )
    ).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.diagnosticCodes)).toBe(true);
    expect(Object.keys(assessor)).toEqual(['authoritativeForMutation', 'assess']);
    expect(result).not.toHaveProperty('admitted');
    expect(result).not.toHaveProperty('mutation');
  });

  it('depends only on a narrow structural lease inspection port', async () => {
    const fixture = createFixture();
    const assessor = fixture.createAssessor(
      {},
      {
        inspectForAdmission: () => ({
          status: 'held',
          evidence: fixture.leaseEvidence,
        }),
      }
    );

    await expect(assessor.assess()).resolves.toMatchObject({
      assessment: 'all_evidence_verified',
      decisions: {
        instanceLease: { status: 'verified', code: 'instance_lease_held' },
      },
    });
  });

  it('defaults every missing evidence port to a typed denial', async () => {
    const fixture = createFixture();
    const result = await createMutationReadinessAssessor({
      instanceLease: fixture.leaseGuard,
      runtimeInstance: fixture.runtimeInstance,
      workspace: fixture.workspace,
      requirements: {
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        minimumFreeBytes: MINIMUM_FREE_BYTES,
        evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS,
        evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
      },
      clock: { nowMs: () => NOW_MS },
    }).assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions.instanceLease.status).toBe('verified');
    expect(result.diagnosticCodes).toEqual([
      'instance_lease_held',
      'runtime_binding_evidence_unavailable',
      'workspace_binding_evidence_unavailable',
      'storage_evidence_unavailable',
      'filesystem_evidence_unavailable',
      'external_writer_evidence_unavailable',
      'recovery_outbox_evidence_unavailable',
    ]);
  });

  it('denies a missing lease port without consulting ambient process state', async () => {
    const fixture = createFixture();
    const result = await createMutationReadinessAssessor({
      instanceLease: null,
      runtimeInstance: fixture.runtimeInstance,
      workspace: fixture.workspace,
      requirements: {
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        minimumFreeBytes: MINIMUM_FREE_BYTES,
        evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS,
        evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
      },
      clock: { nowMs: () => NOW_MS },
    }).assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions.instanceLease).toEqual({
      dimension: 'instanceLease',
      status: 'denied',
      code: 'instance_lease_unavailable',
    });
  });

  it.each([0, MAX_MUTATION_READINESS_ASSESSMENT_TIMEOUT_MS + 1])(
    'rejects an unbounded evaluation timeout of %dms',
    (evaluationTimeoutMs) => {
      const fixture = createFixture();

      expect(() =>
        createMutationReadinessAssessor({
          instanceLease: fixture.leaseGuard,
          runtimeInstance: fixture.runtimeInstance,
          workspace: fixture.workspace,
          requirements: {
            storageSchemaVersion: STORAGE_SCHEMA_VERSION,
            minimumFreeBytes: MINIMUM_FREE_BYTES,
            evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS,
            evaluationTimeoutMs,
          },
          clock: { nowMs: () => NOW_MS },
        })
      ).toThrowError('mutation-readiness-requirements-invalid');
    }
  );

  it.each([
    ['runtimeBinding', 'runtime_binding_evidence_unavailable', 'runtime_binding_evidence_unknown'],
    [
      'workspaceBinding',
      'workspace_binding_evidence_unavailable',
      'workspace_binding_evidence_unknown',
    ],
    ['storage', 'storage_evidence_unavailable', 'storage_evidence_unknown'],
    ['filesystem', 'filesystem_evidence_unavailable', 'filesystem_evidence_unknown'],
    ['externalWriter', 'external_writer_evidence_unavailable', 'external_writer_evidence_unknown'],
    ['recoveryOutbox', 'recovery_outbox_evidence_unavailable', 'recovery_outbox_evidence_unknown'],
  ] as const)(
    'denies explicit unavailable and unknown %s evidence',
    async (dimension, unavailableCode, unknownCode) => {
      for (const [status, code] of [
        ['unavailable', unavailableCode],
        ['unknown', unknownCode],
      ] as const) {
        const fixture = createFixture();
        replaceInspection(fixture, dimension, { status });

        const result = await fixture.createAssessor().assess();

        expect(result.assessment).toBe('denied');
        expect(result.decisions[dimension]).toMatchObject({ status: 'denied', code });
      }
    }
  );

  it('does not upgrade initially unavailable evidence during the final pass', async () => {
    const fixture = createFixture();
    let inspectionCount = 0;
    const assessor = fixture.createAssessor({
      runtimeBinding: {
        inspectRuntimeBinding() {
          inspectionCount += 1;
          return inspectionCount === 1
            ? { status: 'unavailable' }
            : fixture.inspections.runtimeBinding;
        },
      },
    });

    const result = await assessor.assess();

    expect(inspectionCount).toBe(2);
    expect(result.assessment).toBe('denied');
    expect(result.decisions.runtimeBinding.code).toBe('runtime_binding_evidence_unavailable');
  });

  it.each([
    ['runtimeBinding', 'runtime_binding_evidence_stale'],
    ['workspaceBinding', 'workspace_binding_evidence_stale'],
    ['storage', 'storage_evidence_stale'],
    ['filesystem', 'filesystem_evidence_stale'],
    ['externalWriter', 'external_writer_evidence_stale'],
    ['recoveryOutbox', 'recovery_outbox_evidence_stale'],
  ] as const)('denies stale %s evidence', async (dimension, code) => {
    const fixture = createFixture();
    makeStale(fixture, dimension);

    const result = await fixture.createAssessor().assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions[dimension]).toMatchObject({ status: 'denied', code });
  });

  it('denies a released or newly invalid lease without consulting ambient ownership', async () => {
    const released = createFixture();
    const assessmentAfterRelease = released.createAssessor();
    released.leaseGuard.release();

    await expect(assessmentAfterRelease.assess()).resolves.toMatchObject({
      assessment: 'denied',
      decisions: {
        instanceLease: { status: 'denied', code: 'instance_lease_released' },
      },
    });

    const invalid = createFixture();
    const assessmentAfterInvalidity = invalid.createAssessor();
    invalid.leaseHandle.valid = false;

    await expect(assessmentAfterInvalidity.assess()).resolves.toMatchObject({
      assessment: 'denied',
      decisions: {
        instanceLease: { status: 'denied', code: 'instance_lease_invalid' },
        runtimeBinding: {
          status: 'denied',
          code: 'runtime_binding_lease_anchor_unverified',
        },
      },
    });
  });

  it('revalidates the lease after evidence collection and denies release during inspection', async () => {
    const fixture = createFixture();
    const runtimeInspection = fixture.inspections.runtimeBinding;
    const assessor = fixture.createAssessor();
    Object.defineProperty(fixture.inspections, 'runtimeBinding', {
      configurable: true,
      enumerable: true,
      get() {
        fixture.leaseGuard.release();
        return runtimeInspection;
      },
    });

    const result = await assessor.assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions.instanceLease).toMatchObject({
      status: 'denied',
      code: 'instance_lease_released',
    });
  });

  it('turns evidence-port failures into safe unavailable codes', async () => {
    const fixture = createFixture();
    const assessor = fixture.createAssessor();
    Object.defineProperty(fixture.inspections, 'storage', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('sensitive-storage-adapter-detail');
      },
    });

    const result = await assessor.assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions.storage.code).toBe('storage_evidence_unavailable');
    expect(JSON.stringify(result)).not.toContain('sensitive-storage-adapter-detail');
  });

  it('bounds a never-settling evidence port with one deadline and aborts late work', async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture();
      let observedSignal: AbortSignal | undefined;
      const assessor = fixture.createAssessor({
        storage: {
          inspectStorageReadiness(_scope, context) {
            observedSignal = context.signal;
            return new Promise(() => undefined);
          },
        },
      });

      const pendingAssessment = assessor.assess();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUT_MS);

      const result = await pendingAssessment;
      expect(result.assessment).toBe('denied');
      expect(result.decisions.storage).toMatchObject({
        status: 'denied',
        code: 'storage_evidence_timeout',
      });
      expect(observedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      dimension: 'instanceLease',
      code: 'instance_lease_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor(
          {},
          { inspectForAdmission: () => new Promise<never>(() => undefined) }
        );
      },
    },
    {
      dimension: 'runtimeBinding',
      code: 'runtime_binding_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          runtimeBinding: {
            inspectRuntimeBinding: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
    {
      dimension: 'workspaceBinding',
      code: 'workspace_binding_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          workspaceBinding: {
            inspectWorkspaceBinding: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
    {
      dimension: 'storage',
      code: 'storage_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          storage: {
            inspectStorageReadiness: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
    {
      dimension: 'filesystem',
      code: 'filesystem_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          filesystem: {
            inspectFilesystemReadiness: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
    {
      dimension: 'externalWriter',
      code: 'external_writer_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          externalWriter: {
            inspectExternalWriterReadiness: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
    {
      dimension: 'recoveryOutbox',
      code: 'recovery_outbox_evidence_timeout',
      create(fixture: ReadinessFixture) {
        return fixture.createAssessor({
          recoveryOutbox: {
            inspectRecoveryOutboxReadiness: () => new Promise<never>(() => undefined),
          },
        });
      },
    },
  ] as const)(
    'maps a never-settling $dimension inspection to $code',
    async ({ dimension, code, create }) => {
      vi.useFakeTimers();
      try {
        const pendingAssessment = create(createFixture()).assess();
        await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUT_MS);
        const result = await pendingAssessment;

        expect(result.assessment).toBe('denied');
        expect(result.decisions[dimension]).toMatchObject({ status: 'denied', code });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('discards evidence that settles after the shared deadline', async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture();
      const lateStorage = deferred<ReadinessEvidenceInspection<VerifiedStorageReadinessEvidence>>();
      const assessor = fixture.createAssessor({
        storage: {
          inspectStorageReadiness: () => lateStorage.promise,
        },
      });

      const pendingAssessment = assessor.assess();
      await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUT_MS);
      const result = await pendingAssessment;
      lateStorage.resolve(fixture.inspections.storage);
      await Promise.resolve();

      expect(result.decisions.storage.code).toBe('storage_evidence_timeout');
      expect(result.assessment).toBe('denied');
      expect(Object.isFrozen(result)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'lease',
      expectedDimension: 'instanceLease',
      expectedCode: 'instance_lease_released',
      invalidate(fixture: ReadinessFixture) {
        fixture.leaseGuard.release();
      },
    },
    {
      name: 'workspace mount',
      expectedDimension: 'workspaceBinding',
      expectedCode: 'workspace_binding_mount_generation_mismatch',
      invalidate(fixture: ReadinessFixture) {
        fixture.inspections.workspaceBinding = verified({
          ...fixture.evidence.workspaceBinding,
          binding: {
            ...fixture.workspace.binding,
            mountGeneration: fixture.workspace.binding.mountGeneration + 1,
          },
        });
      },
    },
    {
      name: 'external writer observation',
      expectedDimension: 'externalWriter',
      expectedCode: 'external_writer_observation_dirty',
      invalidate(fixture: ReadinessFixture) {
        fixture.inspections.externalWriter = verified({
          ...fixture.evidence.externalWriter,
          observation: 'dirty',
        });
      },
    },
    {
      name: 'recovery state',
      expectedDimension: 'recoveryOutbox',
      expectedCode: 'recovery_pending',
      invalidate(fixture: ReadinessFixture) {
        fixture.inspections.recoveryOutbox = verified({
          ...fixture.evidence.recoveryOutbox,
          recoveryState: 'pending',
          recoveringCommandCount: 1,
        });
      },
    },
  ] as const)(
    'denies $name invalidation while another initial inspection is pending',
    async ({ expectedDimension, expectedCode, invalidate }) => {
      const fixture = createFixture();
      const pendingStorage =
        deferred<ReadinessEvidenceInspection<VerifiedStorageReadinessEvidence>>();
      let storageInspectionCount = 0;
      const assessor = fixture.createAssessor({
        storage: {
          inspectStorageReadiness() {
            storageInspectionCount += 1;
            return storageInspectionCount === 1
              ? pendingStorage.promise
              : fixture.inspections.storage;
          },
        },
      });

      const pendingAssessment = assessor.assess();
      await Promise.resolve();
      expect(storageInspectionCount).toBe(1);
      invalidate(fixture);
      pendingStorage.resolve(fixture.inspections.storage);

      const result = await pendingAssessment;
      expect(result.assessment).toBe('denied');
      expect(result.decisions[expectedDimension]).toMatchObject({
        status: 'denied',
        code: expectedCode,
      });
      expect(storageInspectionCount).toBe(2);
    }
  );

  it.each([
    {
      name: 'changed deployment',
      dimension: 'runtimeBinding',
      code: 'runtime_binding_deployment_mismatch',
      arrange(fixture: ReadinessFixture) {
        const foreign = createFixture('2');
        fixture.inspections.runtimeBinding = verified({
          runtimeInstance: foreign.runtimeInstance,
          leaseAnchor: fixture.leaseEvidence.anchor,
        });
      },
    },
    {
      name: 'changed workspace',
      dimension: 'workspaceBinding',
      code: 'workspace_binding_workspace_mismatch',
      arrange(fixture: ReadinessFixture) {
        const foreign = createFixture('2');
        fixture.inspections.workspaceBinding = verified({
          ...fixture.evidence.workspaceBinding,
          binding: {
            ...fixture.workspace.binding,
            workspaceId: foreign.workspace.binding.workspaceId,
          },
        });
      },
    },
    {
      name: 'changed mount generation',
      dimension: 'workspaceBinding',
      code: 'workspace_binding_mount_generation_mismatch',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.workspaceBinding = verified({
          ...fixture.evidence.workspaceBinding,
          binding: {
            ...fixture.workspace.binding,
            mountGeneration: fixture.workspace.binding.mountGeneration + 1,
          },
        });
      },
    },
    {
      name: 'storage schema mismatch',
      dimension: 'storage',
      code: 'storage_schema_mismatch',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.storage = verified({
          ...fixture.evidence.storage,
          schemaVersion: STORAGE_SCHEMA_VERSION + 1,
        });
      },
    },
    {
      name: 'storage migration pending',
      dimension: 'storage',
      code: 'storage_migration_incomplete',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.storage = verified({
          ...fixture.evidence.storage,
          migrationState: 'pending',
        });
      },
    },
    {
      name: 'filesystem permission denied',
      dimension: 'filesystem',
      code: 'filesystem_permission_unverified',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.filesystem = verified({
          ...fixture.evidence.filesystem,
          permission: 'denied',
        });
      },
    },
    {
      name: 'filesystem free space insufficient',
      dimension: 'filesystem',
      code: 'filesystem_free_space_insufficient',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.filesystem = verified({
          ...fixture.evidence.filesystem,
          freeBytes: MINIMUM_FREE_BYTES - 1,
        });
      },
    },
    {
      name: 'filesystem capability unsupported',
      dimension: 'filesystem',
      code: 'filesystem_unsupported',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.filesystem = verified({
          ...fixture.evidence.filesystem,
          filesystem: 'unsupported',
        });
      },
    },
    {
      name: 'unknown external writer',
      dimension: 'externalWriter',
      code: 'external_writer_class_unknown',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.externalWriter = verified({
          ...fixture.evidence.externalWriter,
          classification: 'unknown',
          coordination: 'unknown',
        });
      },
    },
    {
      name: 'dirty external writer observation',
      dimension: 'externalWriter',
      code: 'external_writer_observation_dirty',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.externalWriter = verified({
          ...fixture.evidence.externalWriter,
          observation: 'dirty',
        });
      },
    },
    {
      name: 'recovery pending',
      dimension: 'recoveryOutbox',
      code: 'recovery_pending',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.recoveryOutbox = verified({
          ...fixture.evidence.recoveryOutbox,
          recoveryState: 'pending',
          recoveringCommandCount: 1,
        });
      },
    },
    {
      name: 'outbox unavailable',
      dimension: 'recoveryOutbox',
      code: 'outbox_unavailable',
      arrange(fixture: ReadinessFixture) {
        fixture.inspections.recoveryOutbox = verified({
          ...fixture.evidence.recoveryOutbox,
          outboxState: 'unavailable',
        });
      },
    },
  ] satisfies readonly {
    name: string;
    dimension: Exclude<MutationReadinessDimension, 'instanceLease'>;
    code:
      | RuntimeBindingReadinessDiagnosticCode
      | WorkspaceBindingReadinessDiagnosticCode
      | StorageReadinessDiagnosticCode
      | FilesystemReadinessDiagnosticCode
      | ExternalWriterReadinessDiagnosticCode
      | RecoveryOutboxReadinessDiagnosticCode;
    arrange(fixture: ReadinessFixture): void;
  }[])('fails closed for $name', async ({ arrange, dimension, code }) => {
    const fixture = createFixture();
    arrange(fixture);

    const result = await fixture.createAssessor().assess();

    expect(result.assessment).toBe('denied');
    expect(result.decisions[dimension]).toMatchObject({ status: 'denied', code });
  });

  it('keeps two RuntimeInstanceContext compositions isolated in one process', async () => {
    const first = createFixture('1');
    const second = createFixture('2');
    const firstAssessment = first.createAssessor();
    const secondAssessment = second.createAssessor();

    await expect(firstAssessment.assess()).resolves.toMatchObject({
      assessment: 'all_evidence_verified',
    });
    await expect(secondAssessment.assess()).resolves.toMatchObject({
      assessment: 'all_evidence_verified',
    });

    first.leaseGuard.release();

    await expect(firstAssessment.assess()).resolves.toMatchObject({
      assessment: 'denied',
      decisions: {
        instanceLease: { code: 'instance_lease_released' },
      },
    });
    await expect(secondAssessment.assess()).resolves.toMatchObject({
      assessment: 'all_evidence_verified',
    });

    second.inspections.runtimeBinding = verified(first.evidence.runtimeBinding);
    const crossBound = await secondAssessment.assess();
    expect(crossBound.assessment).toBe('denied');
    expect(crossBound.decisions.runtimeBinding.code).toBe('runtime_binding_deployment_mismatch');
    expect(first.runtimeInstance).not.toBe(second.runtimeInstance);
    expect(first.leaseGuard).not.toBe(second.leaseGuard);
  });
});
