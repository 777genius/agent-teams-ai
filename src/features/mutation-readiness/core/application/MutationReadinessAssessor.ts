import {
  decideMutationReadiness,
  mutationReadinessDiagnosticCodes,
  type MutationReadinessInspectionOutcomes,
  type ReadinessEvidenceInspectionOutcome,
  snapshotMutationReadinessRequirements,
  snapshotMutationReadinessScope,
} from '../domain';

import type {
  MutationReadinessAssessment,
  MutationReadinessRequirements,
  MutationReadinessScope,
  MutationReadinessWorkspaceTarget,
  ReadinessEvidenceInspection,
  VerifiedExternalWriterReadinessEvidence,
  VerifiedFilesystemReadinessEvidence,
  VerifiedRecoveryOutboxReadinessEvidence,
  VerifiedRuntimeBindingReadinessEvidence,
  VerifiedStorageReadinessEvidence,
  VerifiedWorkspaceBindingReadinessEvidence,
} from '../../contracts';
import type { InstanceLeaseAdmissionInspection } from '@features/instance-lease/contracts';

type MaybePromise<T> = T | Promise<T>;
type InspectionInvocation = (() => unknown | Promise<unknown>) | null;

export interface InstanceLeaseReadinessInspectionContext {
  /** Cooperative cancellation; the assessor also enforces its own deadline. */
  readonly signal: AbortSignal;
}

/** Narrow, non-ambient lease evidence port used by readiness assessment. */
export interface InstanceLeaseReadinessEvidencePort {
  inspectForAdmission(
    context: InstanceLeaseReadinessInspectionContext
  ): MaybePromise<InstanceLeaseAdmissionInspection>;
}

export interface MutationReadinessInspectionContext {
  /**
   * Cooperative cancellation only. Core enforces the deadline independently,
   * aborts this signal once, and discards any later result.
   */
  readonly signal: AbortSignal;
}

export interface RuntimeBindingReadinessEvidencePort {
  inspectRuntimeBinding(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedRuntimeBindingReadinessEvidence>>;
}

export interface WorkspaceBindingReadinessEvidencePort {
  inspectWorkspaceBinding(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedWorkspaceBindingReadinessEvidence>>;
}

export interface StorageReadinessEvidencePort {
  inspectStorageReadiness(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedStorageReadinessEvidence>>;
}

export interface FilesystemReadinessEvidencePort {
  inspectFilesystemReadiness(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedFilesystemReadinessEvidence>>;
}

export interface ExternalWriterReadinessEvidencePort {
  inspectExternalWriterReadiness(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedExternalWriterReadinessEvidence>>;
}

export interface RecoveryOutboxReadinessEvidencePort {
  inspectRecoveryOutboxReadiness(
    scope: MutationReadinessScope,
    context: MutationReadinessInspectionContext
  ): MaybePromise<ReadinessEvidenceInspection<VerifiedRecoveryOutboxReadinessEvidence>>;
}

export interface MutationReadinessEvidencePorts {
  readonly runtimeBinding?: RuntimeBindingReadinessEvidencePort | null;
  readonly workspaceBinding?: WorkspaceBindingReadinessEvidencePort | null;
  readonly storage?: StorageReadinessEvidencePort | null;
  readonly filesystem?: FilesystemReadinessEvidencePort | null;
  readonly externalWriter?: ExternalWriterReadinessEvidencePort | null;
  readonly recoveryOutbox?: RecoveryOutboxReadinessEvidencePort | null;
}

export interface MutationReadinessClock {
  nowMs(): number;
}

export interface MutationReadinessAssessmentInput {
  readonly instanceLease?: InstanceLeaseReadinessEvidencePort | null;
  readonly runtimeInstance: MutationReadinessScope['runtimeInstance'] | null;
  readonly workspace: MutationReadinessWorkspaceTarget | null;
  readonly requirements: MutationReadinessRequirements;
  readonly clock: MutationReadinessClock;
  readonly evidence?: MutationReadinessEvidencePorts;
}

export interface MutationReadinessAssessor {
  readonly authoritativeForMutation: false;
  assess(): Promise<MutationReadinessAssessment>;
}

const UNAVAILABLE_OUTCOME: ReadinessEvidenceInspectionOutcome = Object.freeze({
  status: 'unavailable',
});
const TIMEOUT_OUTCOME: ReadinessEvidenceInspectionOutcome = Object.freeze({ status: 'timeout' });

function invokeSafely(invoke: InspectionInvocation): Promise<ReadinessEvidenceInspectionOutcome> {
  if (!invoke) return Promise.resolve(UNAVAILABLE_OUTCOME);
  return Promise.resolve()
    .then(invoke)
    .then(
      (value): ReadinessEvidenceInspectionOutcome => Object.freeze({ status: 'settled', value }),
      (): ReadinessEvidenceInspectionOutcome => UNAVAILABLE_OUTCOME
    );
}

function invokeEvidencePort(
  evidence: MutationReadinessEvidencePorts,
  dimension: Exclude<keyof MutationReadinessInspectionOutcomes, 'instanceLease'>,
  scope: MutationReadinessScope,
  context: MutationReadinessInspectionContext
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
      if (!port || typeof port.inspectFilesystemReadiness !== 'function') {
        throw new Error('unavailable');
      }
      return port.inspectFilesystemReadiness(scope, context);
    }
    case 'externalWriter': {
      const port = evidence.externalWriter;
      if (!port || typeof port.inspectExternalWriterReadiness !== 'function') {
        throw new Error('unavailable');
      }
      return port.inspectExternalWriterReadiness(scope, context);
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
  readonly instanceLease: MutationReadinessAssessmentInput['instanceLease'];
  readonly evidence: MutationReadinessEvidencePorts;
  readonly scope: MutationReadinessScope | null;
  readonly context: MutationReadinessInspectionContext;
}): Readonly<Record<keyof MutationReadinessInspectionOutcomes, InspectionInvocation>> {
  const evidenceInvocation = (
    dimension: Exclude<keyof MutationReadinessInspectionOutcomes, 'instanceLease'>
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
  readonly invocations: Readonly<
    Record<keyof MutationReadinessInspectionOutcomes, InspectionInvocation>
  >;
  readonly deadline: Promise<ReadinessEvidenceInspectionOutcome>;
  readonly deadlineAtMs: number;
  readonly abortController: AbortController;
}): Promise<MutationReadinessInspectionOutcomes> {
  const settle = async (
    invoke: InspectionInvocation
  ): Promise<ReadinessEvidenceInspectionOutcome> => {
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

function containsTimeout(outcomes: MutationReadinessInspectionOutcomes): boolean {
  return Object.values(outcomes).some((outcome) => outcome.status === 'timeout');
}

function readMutationReadinessClock(clock: MutationReadinessClock): number | null {
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
export function createMutationReadinessAssessor(
  input: MutationReadinessAssessmentInput
): MutationReadinessAssessor {
  const requirements = snapshotMutationReadinessRequirements(input.requirements);
  const scope = snapshotMutationReadinessScope({
    runtimeInstance: input.runtimeInstance,
    workspace: input.workspace,
    requirements,
  });
  const instanceLease = input.instanceLease ?? null;
  const evidence = input.evidence ?? {};
  const clock = input.clock;

  return Object.freeze({
    authoritativeForMutation: false as const,
    async assess(): Promise<MutationReadinessAssessment> {
      const abortController = new AbortController();
      const context: MutationReadinessInspectionContext = Object.freeze({
        signal: abortController.signal,
      });
      let deadlineReached = false;
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const deadlineAtMs = Date.now() + requirements.evaluationTimeoutMs;
      const deadline = new Promise<ReadinessEvidenceInspectionOutcome>((resolve) => {
        deadlineHandle = setTimeout(() => {
          deadlineReached = true;
          abortController.abort();
          resolve(TIMEOUT_OUTCOME);
        }, requirements.evaluationTimeoutMs);
      });

      const invocations = buildInvocations({ instanceLease, evidence, scope, context });
      let initial: MutationReadinessInspectionOutcomes;
      let final: MutationReadinessInspectionOutcomes;
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

      const decisions = decideMutationReadiness({
        initial,
        final,
        scope,
        nowMs: readMutationReadinessClock(clock),
      });
      const diagnosticCodes = mutationReadinessDiagnosticCodes(decisions);
      return Object.freeze({
        kind: 'mutation_readiness_diagnostic' as const,
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
