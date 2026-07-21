import {
  decidePhase3MutationAdmission,
  phase3AssessmentDiagnosticCodes,
  type Phase3PortInspectionOutcome,
  type Phase3PortInspectionOutcomes,
  snapshotPhase3MutationAdmissionRequirements,
  snapshotPhase3MutationAdmissionScope,
} from '../domain';

import type {
  InstanceLeaseAdmissionInspection,
  Phase3EvidenceInspection,
  Phase3MutationAdmissionAssessment,
  Phase3MutationAdmissionRequirements,
  Phase3MutationAdmissionScope,
  Phase3MutationAdmissionWorkspaceTarget,
  Phase3VerifiedExternalWriterEvidence,
  Phase3VerifiedFilesystemEvidence,
  Phase3VerifiedRecoveryOutboxEvidence,
  Phase3VerifiedRuntimeBindingEvidence,
  Phase3VerifiedStorageEvidence,
  Phase3VerifiedWorkspaceBindingEvidence,
} from '../../contracts';

type MaybePromise<T> = T | Promise<T>;
type InspectionInvocation = (() => unknown | Promise<unknown>) | null;

export interface InstanceLeaseAdmissionInspectionContext {
  /** Cooperative cancellation; the assessor also enforces its own deadline. */
  readonly signal: AbortSignal;
}

/** Narrow, non-ambient lease evidence port used by admission assessment. */
export interface InstanceLeaseAdmissionPort {
  inspectForAdmission(
    context: InstanceLeaseAdmissionInspectionContext
  ): MaybePromise<InstanceLeaseAdmissionInspection>;
}

export interface Phase3AdmissionInspectionContext {
  /**
   * Cooperative cancellation only. Core enforces the deadline independently,
   * aborts this signal once, and discards any later result.
   */
  readonly signal: AbortSignal;
}

export interface Phase3RuntimeBindingEvidencePort {
  inspectRuntimeBinding(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedRuntimeBindingEvidence>>;
}

export interface Phase3WorkspaceBindingEvidencePort {
  inspectWorkspaceBinding(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedWorkspaceBindingEvidence>>;
}

export interface Phase3StorageReadinessEvidencePort {
  inspectStorageReadiness(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedStorageEvidence>>;
}

export interface Phase3FilesystemCapabilityEvidencePort {
  inspectFilesystemCapability(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedFilesystemEvidence>>;
}

export interface Phase3ExternalWriterEvidencePort {
  inspectExternalWriterCoordination(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedExternalWriterEvidence>>;
}

export interface Phase3RecoveryOutboxEvidencePort {
  inspectRecoveryOutboxReadiness(
    scope: Phase3MutationAdmissionScope,
    context: Phase3AdmissionInspectionContext
  ): MaybePromise<Phase3EvidenceInspection<Phase3VerifiedRecoveryOutboxEvidence>>;
}

export interface Phase3MutationAdmissionEvidencePorts {
  readonly runtimeBinding?: Phase3RuntimeBindingEvidencePort | null;
  readonly workspaceBinding?: Phase3WorkspaceBindingEvidencePort | null;
  readonly storage?: Phase3StorageReadinessEvidencePort | null;
  readonly filesystem?: Phase3FilesystemCapabilityEvidencePort | null;
  readonly externalWriter?: Phase3ExternalWriterEvidencePort | null;
  readonly recoveryOutbox?: Phase3RecoveryOutboxEvidencePort | null;
}

export interface Phase3MutationAdmissionClock {
  nowMs(): number;
}

export interface Phase3MutationAdmissionInput {
  readonly instanceLease?: InstanceLeaseAdmissionPort | null;
  readonly runtimeInstance: Phase3MutationAdmissionScope['runtimeInstance'] | null;
  readonly workspace: Phase3MutationAdmissionWorkspaceTarget | null;
  readonly requirements: Phase3MutationAdmissionRequirements;
  readonly clock: Phase3MutationAdmissionClock;
  readonly evidence?: Phase3MutationAdmissionEvidencePorts;
}

export interface Phase3MutationAdmissionAssessor {
  readonly authoritativeForMutation: false;
  assess(): Promise<Phase3MutationAdmissionAssessment>;
}

const UNAVAILABLE_OUTCOME: Phase3PortInspectionOutcome = Object.freeze({
  status: 'unavailable',
});
const TIMEOUT_OUTCOME: Phase3PortInspectionOutcome = Object.freeze({ status: 'timeout' });

function invokeSafely(invoke: InspectionInvocation): Promise<Phase3PortInspectionOutcome> {
  if (!invoke) return Promise.resolve(UNAVAILABLE_OUTCOME);
  return Promise.resolve()
    .then(invoke)
    .then(
      (value): Phase3PortInspectionOutcome => Object.freeze({ status: 'settled', value }),
      (): Phase3PortInspectionOutcome => UNAVAILABLE_OUTCOME
    );
}

function invokeEvidencePort(
  evidence: Phase3MutationAdmissionEvidencePorts,
  dimension: Exclude<keyof Phase3PortInspectionOutcomes, 'instanceLease'>,
  scope: Phase3MutationAdmissionScope,
  context: Phase3AdmissionInspectionContext
): unknown | Promise<unknown> {
  switch (dimension) {
    case 'runtimeBinding': {
      const port = evidence.runtimeBinding;
      if (!port || typeof port.inspectRuntimeBinding !== 'function') throw new Error('unavailable');
      return port.inspectRuntimeBinding(scope, context);
    }
    case 'workspaceBinding': {
      const port = evidence.workspaceBinding;
      if (!port || typeof port.inspectWorkspaceBinding !== 'function')
        throw new Error('unavailable');
      return port.inspectWorkspaceBinding(scope, context);
    }
    case 'storage': {
      const port = evidence.storage;
      if (!port || typeof port.inspectStorageReadiness !== 'function')
        throw new Error('unavailable');
      return port.inspectStorageReadiness(scope, context);
    }
    case 'filesystem': {
      const port = evidence.filesystem;
      if (!port || typeof port.inspectFilesystemCapability !== 'function') {
        throw new Error('unavailable');
      }
      return port.inspectFilesystemCapability(scope, context);
    }
    case 'externalWriter': {
      const port = evidence.externalWriter;
      if (!port || typeof port.inspectExternalWriterCoordination !== 'function') {
        throw new Error('unavailable');
      }
      return port.inspectExternalWriterCoordination(scope, context);
    }
    case 'recoveryOutbox': {
      const port = evidence.recoveryOutbox;
      if (!port || typeof port.inspectRecoveryOutboxReadiness !== 'function') {
        throw new Error('unavailable');
      }
      return port.inspectRecoveryOutboxReadiness(scope, context);
    }
  }
}

function buildInvocations(input: {
  readonly instanceLease: Phase3MutationAdmissionInput['instanceLease'];
  readonly evidence: Phase3MutationAdmissionEvidencePorts;
  readonly scope: Phase3MutationAdmissionScope | null;
  readonly context: Phase3AdmissionInspectionContext;
}): Readonly<Record<keyof Phase3PortInspectionOutcomes, InspectionInvocation>> {
  const evidenceInvocation = (
    dimension: Exclude<keyof Phase3PortInspectionOutcomes, 'instanceLease'>
  ): InspectionInvocation =>
    input.scope
      ? () => invokeEvidencePort(input.evidence, dimension, input.scope!, input.context)
      : null;

  return Object.freeze({
    instanceLease: input.instanceLease
      ? () => input.instanceLease!.inspectForAdmission(input.context)
      : null,
    runtimeBinding: evidenceInvocation('runtimeBinding'),
    workspaceBinding: evidenceInvocation('workspaceBinding'),
    storage: evidenceInvocation('storage'),
    filesystem: evidenceInvocation('filesystem'),
    externalWriter: evidenceInvocation('externalWriter'),
    recoveryOutbox: evidenceInvocation('recoveryOutbox'),
  });
}

async function collectInspectionsBeforeDeadline(input: {
  readonly invocations: Readonly<Record<keyof Phase3PortInspectionOutcomes, InspectionInvocation>>;
  readonly deadline: Promise<Phase3PortInspectionOutcome>;
  readonly deadlineAtMs: number;
  readonly abortController: AbortController;
}): Promise<Phase3PortInspectionOutcomes> {
  const settle = async (invoke: InspectionInvocation): Promise<Phase3PortInspectionOutcome> => {
    const outcome = await Promise.race([invokeSafely(invoke), input.deadline]);
    if (Date.now() >= input.deadlineAtMs) {
      input.abortController.abort();
      return TIMEOUT_OUTCOME;
    }
    return outcome;
  };
  const [
    instanceLease,
    runtimeBinding,
    workspaceBinding,
    storage,
    filesystem,
    externalWriter,
    recoveryOutbox,
  ] = await Promise.all([
    settle(input.invocations.instanceLease),
    settle(input.invocations.runtimeBinding),
    settle(input.invocations.workspaceBinding),
    settle(input.invocations.storage),
    settle(input.invocations.filesystem),
    settle(input.invocations.externalWriter),
    settle(input.invocations.recoveryOutbox),
  ]);
  return Object.freeze({
    instanceLease,
    runtimeBinding,
    workspaceBinding,
    storage,
    filesystem,
    externalWriter,
    recoveryOutbox,
  });
}

function containsTimeout(outcomes: Phase3PortInspectionOutcomes): boolean {
  return Object.values(outcomes).some((outcome) => outcome.status === 'timeout');
}

function readPhase3MutationAdmissionClock(clock: Phase3MutationAdmissionClock): number | null {
  try {
    const nowMs = clock.nowMs();
    return Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : null;
  } catch {
    return null;
  }
}

/**
 * Builds a read-only, diagnostic assessor. It performs an initial inspection
 * and one final reinspection behind a shared barrier, all under one bounded
 * deadline. The final pass catches evidence invalidated while another initial
 * inspection was pending. Late adapter results are ignored.
 */
export function createPhase3MutationAdmissionAssessor(
  input: Phase3MutationAdmissionInput
): Phase3MutationAdmissionAssessor {
  const requirements = snapshotPhase3MutationAdmissionRequirements(input.requirements);
  const scope = snapshotPhase3MutationAdmissionScope({
    runtimeInstance: input.runtimeInstance,
    workspace: input.workspace,
    requirements,
  });
  const instanceLease = input.instanceLease ?? null;
  const evidence = input.evidence ?? {};
  const clock = input.clock;

  return Object.freeze({
    authoritativeForMutation: false as const,
    async assess(): Promise<Phase3MutationAdmissionAssessment> {
      const abortController = new AbortController();
      const context: Phase3AdmissionInspectionContext = Object.freeze({
        signal: abortController.signal,
      });
      let deadlineReached = false;
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const deadlineAtMs = Date.now() + requirements.evaluationTimeoutMs;
      const deadline = new Promise<Phase3PortInspectionOutcome>((resolve) => {
        deadlineHandle = setTimeout(() => {
          deadlineReached = true;
          abortController.abort();
          resolve(TIMEOUT_OUTCOME);
        }, requirements.evaluationTimeoutMs);
      });

      const invocations = buildInvocations({ instanceLease, evidence, scope, context });
      let initial: Phase3PortInspectionOutcomes;
      let final: Phase3PortInspectionOutcomes;
      try {
        initial = await collectInspectionsBeforeDeadline({
          invocations,
          deadline,
          deadlineAtMs,
          abortController,
        });
        final =
          deadlineReached || containsTimeout(initial)
            ? initial
            : await collectInspectionsBeforeDeadline({
                invocations,
                deadline,
                deadlineAtMs,
                abortController,
              });
      } finally {
        if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
        abortController.abort();
      }

      const decisions = decidePhase3MutationAdmission({
        initial,
        final,
        scope,
        nowMs: readPhase3MutationAdmissionClock(clock),
      });
      const diagnosticCodes = phase3AssessmentDiagnosticCodes(decisions);
      return Object.freeze({
        kind: 'phase3_mutation_admission_diagnostic' as const,
        assessment: Object.values(decisions).every((value) => value.status === 'verified')
          ? ('all_evidence_verified' as const)
          : ('denied' as const),
        authoritativeForMutation: false as const,
        decisions,
        diagnosticCodes,
      });
    },
  });
}
