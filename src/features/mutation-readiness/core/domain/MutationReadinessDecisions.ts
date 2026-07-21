import {
  INSTANCE_LEASE_PROTOCOL_VERSION,
  type InstanceLeaseAdmissionInspection,
  type InstanceLeaseAnchorEvidence,
  type InstanceLeaseLauncherEvidence,
} from '@features/instance-lease/contracts';
import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
  type RuntimeRootReference,
} from '@features/runtime-instance-context';
import {
  parseDeclaredRootHash,
  parseRegistrationRevision,
  parseWorkspaceMountBindingRef,
  type WorkspaceMountBindingRef,
} from '@features/workspace-registry/contracts';

import {
  type ExternalWriterReadinessClassification,
  type ExternalWriterReadinessCoordination,
  type ExternalWriterReadinessDecision,
  type FilesystemReadinessDecision,
  type InstanceLeaseReadinessDecision,
  MAX_MUTATION_READINESS_ASSESSMENT_TIMEOUT_MS,
  MUTATION_READINESS_DIMENSIONS,
  type MutationReadinessDecisions,
  type MutationReadinessDecisionStatus,
  type MutationReadinessDiagnosticCode,
  type MutationReadinessDimension,
  type MutationReadinessDimensionDecision,
  type MutationReadinessRequirements,
  type MutationReadinessScope,
  type MutationReadinessWorkspaceTarget,
  type RecoveryOutboxReadinessDecision,
  type RuntimeBindingReadinessDecision,
  type StorageReadinessDecision,
  type WorkspaceBindingReadinessDecision,
} from '../../contracts';

const DECIMAL_KERNEL_ID = /^(?:0|[1-9][0-9]*)$/;

export type ReadinessEvidenceInspectionOutcome =
  | { readonly status: 'settled'; readonly value: unknown }
  | { readonly status: 'unavailable' | 'timeout' };

export interface MutationReadinessInspectionOutcomes {
  readonly instanceLease: ReadinessEvidenceInspectionOutcome;
  readonly runtimeBinding: ReadinessEvidenceInspectionOutcome;
  readonly workspaceBinding: ReadinessEvidenceInspectionOutcome;
  readonly storage: ReadinessEvidenceInspectionOutcome;
  readonly filesystem: ReadinessEvidenceInspectionOutcome;
  readonly externalWriter: ReadinessEvidenceInspectionOutcome;
  readonly recoveryOutbox: ReadinessEvidenceInspectionOutcome;
}

interface VerifiedInspection {
  readonly status: 'verified';
  readonly checkedAtMs: number;
  readonly evidence: unknown;
}

type ParsedInspection =
  | VerifiedInspection
  | { readonly status: 'unavailable' | 'timeout' | 'unknown' | 'invalid' };

type ParsedLeaseInspection =
  | InstanceLeaseAdmissionInspection
  | { readonly status: 'unavailable' | 'timeout' };

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      return null;
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function parseAnchorEvidence(value: unknown): InstanceLeaseAnchorEvidence | null {
  const record = readExactRecord(value, ['device', 'inode', 'mode', 'uid', 'linkCount']);
  if (
    !record ||
    typeof record.device !== 'string' ||
    !DECIMAL_KERNEL_ID.test(record.device) ||
    typeof record.inode !== 'string' ||
    !DECIMAL_KERNEL_ID.test(record.inode) ||
    record.inode === '0' ||
    !Number.isSafeInteger(record.mode) ||
    (record.mode as number) < 0 ||
    ((record.mode as number) & 0o170000) !== 0o100000 ||
    ((record.mode as number) & 0o22) !== 0 ||
    record.uid !== 0 ||
    record.linkCount !== 1
  ) {
    return null;
  }
  return Object.freeze({
    device: record.device,
    inode: record.inode,
    mode: record.mode as number,
    uid: 0,
    linkCount: 1,
  });
}

function parseLeaseEvidence(value: unknown): InstanceLeaseLauncherEvidence | null {
  const record = readExactRecord(value, [
    'protocolVersion',
    'launcherPid',
    'controllerPid',
    'anchor',
  ]);
  const anchor = parseAnchorEvidence(record?.anchor);
  if (
    !record ||
    record.protocolVersion !== INSTANCE_LEASE_PROTOCOL_VERSION ||
    !positiveInteger(record.launcherPid) ||
    !positiveInteger(record.controllerPid) ||
    !anchor
  ) {
    return null;
  }
  return Object.freeze({
    protocolVersion: INSTANCE_LEASE_PROTOCOL_VERSION,
    launcherPid: record.launcherPid,
    controllerPid: record.controllerPid,
    anchor,
  });
}

function parseLeaseInspection(outcome: ReadinessEvidenceInspectionOutcome): ParsedLeaseInspection {
  if (outcome.status !== 'settled') return Object.freeze({ status: outcome.status });
  const terminal = readExactRecord(outcome.value, ['status']);
  if (terminal?.status === 'invalid' || terminal?.status === 'released') {
    return Object.freeze({ status: terminal.status });
  }
  const held = readExactRecord(outcome.value, ['status', 'evidence']);
  const evidence = parseLeaseEvidence(held?.evidence);
  if (held?.status !== 'held' || !evidence) return Object.freeze({ status: 'invalid' });
  return Object.freeze({ status: 'held', evidence });
}

function parseInspection(outcome: ReadinessEvidenceInspectionOutcome): ParsedInspection {
  if (outcome.status !== 'settled') return Object.freeze({ status: outcome.status });
  const statusRecord = readExactRecord(outcome.value, ['status']);
  if (statusRecord?.status === 'unavailable' || statusRecord?.status === 'unknown') {
    return Object.freeze({ status: statusRecord.status });
  }
  const verified = readExactRecord(outcome.value, ['status', 'checkedAtMs', 'evidence']);
  if (
    verified?.status !== 'verified' ||
    !Number.isSafeInteger(verified.checkedAtMs) ||
    (verified.checkedAtMs as number) < 0
  ) {
    return Object.freeze({ status: 'invalid' });
  }
  return Object.freeze({
    status: 'verified',
    checkedAtMs: verified.checkedAtMs as number,
    evidence: verified.evidence,
  });
}

function isFresh(
  inspection: VerifiedInspection,
  nowMs: number | null,
  evidenceMaxAgeMs: number
): boolean {
  return (
    nowMs !== null &&
    inspection.checkedAtMs <= nowMs &&
    nowMs - inspection.checkedAtMs <= evidenceMaxAgeMs
  );
}

function parseWorkspaceRootReference(value: unknown): RuntimeRootReference<'workspace'> | null {
  const record = readExactRecord(value, ['kind', 'reference']);
  if (
    record?.kind !== 'workspace' ||
    typeof record.reference !== 'string' ||
    record.reference.length === 0 ||
    record.reference.trim() !== record.reference
  ) {
    return null;
  }
  return Object.freeze({
    kind: 'workspace',
    reference: record.reference as RuntimeRootReference<'workspace'>['reference'],
  });
}

function parseWorkspaceBinding(value: unknown): WorkspaceMountBindingRef | null {
  if (!readExactRecord(value, ['workspaceId', 'bootId', 'mountGeneration'])) return null;
  try {
    return parseWorkspaceMountBindingRef(value);
  } catch {
    return null;
  }
}

function snapshotWorkspaceTarget(value: unknown): MutationReadinessWorkspaceTarget | null {
  const record = readExactRecord(value, [
    'binding',
    'rootReference',
    'declaredRootHash',
    'registrationRevision',
  ]);
  if (!record) return null;
  const binding = parseWorkspaceBinding(record.binding);
  const rootReference = parseWorkspaceRootReference(record.rootReference);
  if (!binding || !rootReference) return null;
  try {
    return Object.freeze({
      binding,
      rootReference,
      declaredRootHash: parseDeclaredRootHash(record.declaredRootHash),
      registrationRevision: parseRegistrationRevision(record.registrationRevision),
    });
  } catch {
    return null;
  }
}

function snapshotRuntimeInstance(value: unknown): RuntimeInstanceContext | null {
  try {
    return createRuntimeInstanceContext(value);
  } catch {
    return null;
  }
}

export function snapshotMutationReadinessRequirements(
  value: unknown
): MutationReadinessRequirements {
  const record = readExactRecord(value, [
    'storageSchemaVersion',
    'minimumFreeBytes',
    'evidenceMaxAgeMs',
    'evaluationTimeoutMs',
  ]);
  if (
    !record ||
    !positiveInteger(record.storageSchemaVersion) ||
    !positiveInteger(record.minimumFreeBytes) ||
    !positiveInteger(record.evidenceMaxAgeMs) ||
    !positiveInteger(record.evaluationTimeoutMs) ||
    record.evaluationTimeoutMs > MAX_MUTATION_READINESS_ASSESSMENT_TIMEOUT_MS
  ) {
    throw new TypeError('mutation-readiness-requirements-invalid');
  }
  return Object.freeze({
    storageSchemaVersion: record.storageSchemaVersion,
    minimumFreeBytes: record.minimumFreeBytes,
    evidenceMaxAgeMs: record.evidenceMaxAgeMs,
    evaluationTimeoutMs: record.evaluationTimeoutMs,
  });
}

export function snapshotMutationReadinessScope(input: {
  readonly runtimeInstance: unknown;
  readonly workspace: unknown;
  readonly requirements: MutationReadinessRequirements;
}): MutationReadinessScope | null {
  const runtimeInstance = snapshotRuntimeInstance(input.runtimeInstance);
  const workspace = snapshotWorkspaceTarget(input.workspace);
  return runtimeInstance && workspace
    ? Object.freeze({ runtimeInstance, workspace, requirements: input.requirements })
    : null;
}

function sameAnchor(
  left: InstanceLeaseAnchorEvidence,
  right: InstanceLeaseAnchorEvidence
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.linkCount === right.linkCount
  );
}

function sameLeaseEvidence(
  left: InstanceLeaseLauncherEvidence,
  right: InstanceLeaseLauncherEvidence
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.launcherPid === right.launcherPid &&
    left.controllerPid === right.controllerPid &&
    sameAnchor(left.anchor, right.anchor)
  );
}

function sameRuntimeInstance(left: RuntimeInstanceContext, right: RuntimeInstanceContext): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.claudeRoot.reference === right.claudeRoot.reference &&
    left.appDataRoot.reference === right.appDataRoot.reference &&
    left.tempRoot.reference === right.tempRoot.reference &&
    left.logsRoot.reference === right.logsRoot.reference &&
    left.workspaceRoots.length === right.workspaceRoots.length &&
    left.workspaceRoots.every(
      (root, index) => root.reference === right.workspaceRoots[index]?.reference
    )
  );
}

function sameWorkspaceBinding(
  left: WorkspaceMountBindingRef,
  right: WorkspaceMountBindingRef
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.bootId === right.bootId &&
    left.mountGeneration === right.mountGeneration
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function decision<
  TDimension extends MutationReadinessDimension,
  TCode extends MutationReadinessDiagnosticCode,
>(
  dimension: TDimension,
  status: MutationReadinessDecisionStatus,
  code: TCode
): MutationReadinessDimensionDecision<TDimension, TCode> {
  return Object.freeze({ dimension, status, code });
}

function unavailableUnknownOrTimeoutCode<TCode extends string>(
  inspection: ParsedInspection,
  codes: {
    readonly unavailable: TCode;
    readonly timeout: TCode;
    readonly unknown: TCode;
    readonly invalid: TCode;
  }
): TCode {
  if (inspection.status === 'unavailable') return codes.unavailable;
  if (inspection.status === 'timeout') return codes.timeout;
  if (inspection.status === 'unknown') return codes.unknown;
  return codes.invalid;
}

function decideLease(
  initial: ParsedLeaseInspection,
  final: ParsedLeaseInspection
): InstanceLeaseReadinessDecision {
  if (initial.status === 'timeout' || final.status === 'timeout') {
    return decision('instanceLease', 'denied', 'instance_lease_evidence_timeout');
  }
  if (initial.status === 'unavailable' || final.status === 'unavailable') {
    return decision('instanceLease', 'denied', 'instance_lease_unavailable');
  }
  if (initial.status === 'released' || final.status === 'released') {
    return decision('instanceLease', 'denied', 'instance_lease_released');
  }
  if (initial.status !== 'held' || final.status !== 'held') {
    return decision('instanceLease', 'denied', 'instance_lease_invalid');
  }
  if (!sameLeaseEvidence(initial.evidence, final.evidence)) {
    return decision('instanceLease', 'denied', 'instance_lease_changed');
  }
  return decision('instanceLease', 'verified', 'instance_lease_held');
}

function decideRuntimeBinding(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  lease: ParsedLeaseInspection,
  nowMs: number | null
): RuntimeBindingReadinessDecision {
  if (!scope) {
    return decision('runtimeBinding', 'denied', 'runtime_context_unavailable');
  }
  if (inspection.status !== 'verified') {
    return decision(
      'runtimeBinding',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'runtime_binding_evidence_unavailable',
        timeout: 'runtime_binding_evidence_timeout',
        unknown: 'runtime_binding_evidence_unknown',
        invalid: 'runtime_binding_evidence_invalid',
      })
    );
  }
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_evidence_stale');
  }
  const evidenceRecord = readExactRecord(inspection.evidence, ['runtimeInstance', 'leaseAnchor']);
  const observedRuntime = snapshotRuntimeInstance(evidenceRecord?.runtimeInstance);
  const observedAnchor = parseAnchorEvidence(evidenceRecord?.leaseAnchor);
  if (!evidenceRecord || !observedRuntime || !observedAnchor) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_evidence_invalid');
  }
  if (observedRuntime.deploymentId !== scope.runtimeInstance.deploymentId) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_deployment_mismatch');
  }
  if (observedRuntime.bootId !== scope.runtimeInstance.bootId) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_boot_mismatch');
  }
  if (!sameRuntimeInstance(observedRuntime, scope.runtimeInstance)) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_roots_mismatch');
  }
  if (lease.status !== 'held') {
    return decision('runtimeBinding', 'denied', 'runtime_binding_lease_anchor_unverified');
  }
  if (!sameAnchor(observedAnchor, lease.evidence.anchor)) {
    return decision('runtimeBinding', 'denied', 'runtime_binding_lease_anchor_mismatch');
  }
  return decision('runtimeBinding', 'verified', 'runtime_binding_verified');
}

function decideWorkspaceBinding(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  nowMs: number | null
): WorkspaceBindingReadinessDecision {
  if (!scope) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_context_unavailable');
  }
  if (inspection.status !== 'verified') {
    return decision(
      'workspaceBinding',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'workspace_binding_evidence_unavailable',
        timeout: 'workspace_binding_evidence_timeout',
        unknown: 'workspace_binding_evidence_unknown',
        invalid: 'workspace_binding_evidence_invalid',
      })
    );
  }
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_evidence_stale');
  }
  const record = readExactRecord(inspection.evidence, [
    'binding',
    'rootReference',
    'declaredRootHash',
    'registrationRevision',
    'health',
  ]);
  const binding = parseWorkspaceBinding(record?.binding);
  const rootReference = parseWorkspaceRootReference(record?.rootReference);
  if (
    !record ||
    !binding ||
    !rootReference ||
    !['healthy', 'read-only', 'unavailable'].includes(record.health as string)
  ) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_evidence_invalid');
  }
  if (binding.workspaceId !== scope.workspace.binding.workspaceId) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_workspace_mismatch');
  }
  if (
    binding.bootId !== scope.runtimeInstance.bootId ||
    binding.bootId !== scope.workspace.binding.bootId
  ) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_boot_mismatch');
  }
  if (binding.mountGeneration !== scope.workspace.binding.mountGeneration) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_mount_generation_mismatch');
  }
  const matchingRuntimeRoots = scope.runtimeInstance.workspaceRoots.filter(
    (candidate) => candidate.reference === rootReference.reference
  );
  if (
    rootReference.reference !== scope.workspace.rootReference.reference ||
    matchingRuntimeRoots.length !== 1
  ) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_root_mismatch');
  }
  if (
    record.declaredRootHash !== scope.workspace.declaredRootHash ||
    record.registrationRevision !== scope.workspace.registrationRevision
  ) {
    return decision('workspaceBinding', 'denied', 'workspace_binding_registration_mismatch');
  }
  if (record.health !== 'healthy') {
    return decision('workspaceBinding', 'denied', 'workspace_binding_not_writable');
  }
  return decision('workspaceBinding', 'verified', 'workspace_binding_verified');
}

function decideStorage(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  nowMs: number | null
): StorageReadinessDecision {
  if (inspection.status !== 'verified') {
    return decision(
      'storage',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'storage_evidence_unavailable',
        timeout: 'storage_evidence_timeout',
        unknown: 'storage_evidence_unknown',
        invalid: 'storage_evidence_invalid',
      })
    );
  }
  if (!scope) return decision('storage', 'denied', 'storage_evidence_invalid');
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('storage', 'denied', 'storage_evidence_stale');
  }
  const record = readExactRecord(inspection.evidence, [
    'deploymentId',
    'appDataRootReference',
    'backend',
    'compatibility',
    'schemaVersion',
    'migrationState',
    'integrity',
    'criticalFallback',
  ]);
  if (!record || !positiveInteger(record.schemaVersion)) {
    return decision('storage', 'denied', 'storage_evidence_invalid');
  }
  if (
    record.deploymentId !== scope.runtimeInstance.deploymentId ||
    record.appDataRootReference !== scope.runtimeInstance.appDataRoot.reference
  ) {
    return decision('storage', 'denied', 'storage_binding_mismatch');
  }
  if (record.backend !== 'sqlite') {
    return decision('storage', 'denied', 'storage_backend_unavailable');
  }
  if (record.compatibility !== 'verified') {
    return decision('storage', 'denied', 'storage_compatibility_unverified');
  }
  if (record.schemaVersion !== scope.requirements.storageSchemaVersion) {
    return decision('storage', 'denied', 'storage_schema_mismatch');
  }
  if (record.migrationState !== 'complete') {
    return decision('storage', 'denied', 'storage_migration_incomplete');
  }
  if (record.integrity !== 'ok') {
    return decision('storage', 'denied', 'storage_integrity_unverified');
  }
  if (record.criticalFallback !== 'disabled') {
    return decision('storage', 'denied', 'storage_critical_fallback_enabled');
  }
  return decision('storage', 'verified', 'storage_ready');
}

function decideFilesystem(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  nowMs: number | null
): FilesystemReadinessDecision {
  if (inspection.status !== 'verified') {
    return decision(
      'filesystem',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'filesystem_evidence_unavailable',
        timeout: 'filesystem_evidence_timeout',
        unknown: 'filesystem_evidence_unknown',
        invalid: 'filesystem_evidence_invalid',
      })
    );
  }
  if (!scope) return decision('filesystem', 'denied', 'filesystem_evidence_invalid');
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('filesystem', 'denied', 'filesystem_evidence_stale');
  }
  const record = readExactRecord(inspection.evidence, [
    'deploymentId',
    'bootId',
    'workspaceBinding',
    'rootReference',
    'filesystem',
    'permission',
    'freeBytes',
    'atomicReplace',
    'directoryDurability',
  ]);
  const binding = parseWorkspaceBinding(record?.workspaceBinding);
  const rootReference = parseWorkspaceRootReference(record?.rootReference);
  if (!record || !binding || !rootReference || !nonNegativeInteger(record.freeBytes)) {
    return decision('filesystem', 'denied', 'filesystem_evidence_invalid');
  }
  if (
    record.deploymentId !== scope.runtimeInstance.deploymentId ||
    record.bootId !== scope.runtimeInstance.bootId ||
    !sameWorkspaceBinding(binding, scope.workspace.binding) ||
    rootReference.reference !== scope.workspace.rootReference.reference
  ) {
    return decision('filesystem', 'denied', 'filesystem_binding_mismatch');
  }
  if (record.filesystem !== 'supported') {
    return decision('filesystem', 'denied', 'filesystem_unsupported');
  }
  if (record.permission !== 'read_write') {
    return decision('filesystem', 'denied', 'filesystem_permission_unverified');
  }
  if (record.freeBytes < scope.requirements.minimumFreeBytes) {
    return decision('filesystem', 'denied', 'filesystem_free_space_insufficient');
  }
  if (record.atomicReplace !== 'verified') {
    return decision('filesystem', 'denied', 'filesystem_atomic_replace_unverified');
  }
  if (record.directoryDurability !== 'verified') {
    return decision('filesystem', 'denied', 'filesystem_directory_durability_unverified');
  }
  return decision('filesystem', 'verified', 'filesystem_ready');
}

function expectedExternalCoordination(
  classification: ExternalWriterReadinessClassification
): ExternalWriterReadinessCoordination | null {
  switch (classification) {
    case 'app_exclusive':
      return 'lease_fenced';
    case 'cooperative_external':
      return 'protocol_verified';
    case 'provider_mediated':
      return 'provider_protocol_verified';
    case 'quiescent_only':
      return 'quiesced';
    case 'unknown':
    case 'unavailable':
      return null;
  }
}

function decideExternalWriter(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  nowMs: number | null
): ExternalWriterReadinessDecision {
  if (inspection.status !== 'verified') {
    return decision(
      'externalWriter',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'external_writer_evidence_unavailable',
        timeout: 'external_writer_evidence_timeout',
        unknown: 'external_writer_evidence_unknown',
        invalid: 'external_writer_evidence_invalid',
      })
    );
  }
  if (!scope) {
    return decision('externalWriter', 'denied', 'external_writer_evidence_invalid');
  }
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('externalWriter', 'denied', 'external_writer_evidence_stale');
  }
  const record = readExactRecord(inspection.evidence, [
    'deploymentId',
    'bootId',
    'workspaceBinding',
    'classification',
    'coordination',
    'observation',
    'fileWriterEpoch',
    'observationWatermark',
  ]);
  const binding = parseWorkspaceBinding(record?.workspaceBinding);
  if (
    !record ||
    !binding ||
    !positiveInteger(record.fileWriterEpoch) ||
    !nonNegativeInteger(record.observationWatermark)
  ) {
    return decision('externalWriter', 'denied', 'external_writer_evidence_invalid');
  }
  if (
    record.deploymentId !== scope.runtimeInstance.deploymentId ||
    record.bootId !== scope.runtimeInstance.bootId ||
    !sameWorkspaceBinding(binding, scope.workspace.binding)
  ) {
    return decision('externalWriter', 'denied', 'external_writer_binding_mismatch');
  }
  if (record.classification === 'unknown') {
    return decision('externalWriter', 'denied', 'external_writer_class_unknown');
  }
  if (record.classification === 'unavailable') {
    return decision('externalWriter', 'denied', 'external_writer_class_unavailable');
  }
  const expected = expectedExternalCoordination(
    record.classification as ExternalWriterReadinessClassification
  );
  if (!expected || record.coordination !== expected) {
    return decision('externalWriter', 'denied', 'external_writer_coordination_unverified');
  }
  if (record.observation !== 'clean') {
    return decision('externalWriter', 'denied', 'external_writer_observation_dirty');
  }
  return decision('externalWriter', 'verified', 'external_writer_coordinated');
}

function decideRecoveryOutbox(
  inspection: ParsedInspection,
  scope: MutationReadinessScope | null,
  nowMs: number | null
): RecoveryOutboxReadinessDecision {
  if (inspection.status !== 'verified') {
    return decision(
      'recoveryOutbox',
      'denied',
      unavailableUnknownOrTimeoutCode(inspection, {
        unavailable: 'recovery_outbox_evidence_unavailable',
        timeout: 'recovery_outbox_evidence_timeout',
        unknown: 'recovery_outbox_evidence_unknown',
        invalid: 'recovery_outbox_evidence_invalid',
      })
    );
  }
  if (!scope) {
    return decision('recoveryOutbox', 'denied', 'recovery_outbox_evidence_invalid');
  }
  if (!isFresh(inspection, nowMs, scope.requirements.evidenceMaxAgeMs)) {
    return decision('recoveryOutbox', 'denied', 'recovery_outbox_evidence_stale');
  }
  const record = readExactRecord(inspection.evidence, [
    'deploymentId',
    'storageSchemaVersion',
    'scanState',
    'recoveryState',
    'outboxState',
    'pendingCommandCount',
    'recoveringCommandCount',
    'operatorRequiredCount',
    'unknownRecordCount',
  ]);
  if (
    !record ||
    !positiveInteger(record.storageSchemaVersion) ||
    !nonNegativeInteger(record.pendingCommandCount) ||
    !nonNegativeInteger(record.recoveringCommandCount) ||
    !nonNegativeInteger(record.operatorRequiredCount) ||
    !nonNegativeInteger(record.unknownRecordCount)
  ) {
    return decision('recoveryOutbox', 'denied', 'recovery_outbox_evidence_invalid');
  }
  if (
    record.deploymentId !== scope.runtimeInstance.deploymentId ||
    record.storageSchemaVersion !== scope.requirements.storageSchemaVersion
  ) {
    return decision('recoveryOutbox', 'denied', 'recovery_outbox_binding_mismatch');
  }
  if (record.scanState !== 'complete') {
    return decision('recoveryOutbox', 'denied', 'recovery_scan_incomplete');
  }
  if (
    record.recoveryState !== 'complete' ||
    record.pendingCommandCount !== 0 ||
    record.recoveringCommandCount !== 0
  ) {
    return decision('recoveryOutbox', 'denied', 'recovery_pending');
  }
  if (record.operatorRequiredCount !== 0) {
    return decision('recoveryOutbox', 'denied', 'recovery_operator_required');
  }
  if (record.unknownRecordCount !== 0) {
    return decision('recoveryOutbox', 'denied', 'recovery_unknown_records');
  }
  if (record.outboxState !== 'ready') {
    return decision('recoveryOutbox', 'denied', 'outbox_unavailable');
  }
  return decision('recoveryOutbox', 'verified', 'recovery_outbox_ready');
}

export function decideMutationReadiness(input: {
  readonly initial: MutationReadinessInspectionOutcomes;
  readonly final: MutationReadinessInspectionOutcomes;
  readonly scope: MutationReadinessScope | null;
  readonly nowMs: number | null;
}): MutationReadinessDecisions {
  const initialLease = parseLeaseInspection(input.initial.instanceLease);
  const finalLease = parseLeaseInspection(input.final.instanceLease);
  const initial = input.initial;
  const final = input.final;
  const stableDecision = <TDecision extends { readonly status: MutationReadinessDecisionStatus }>(
    initialDecision: TDecision,
    finalDecision: TDecision
  ): TDecision => {
    if (finalDecision.status === 'denied') return finalDecision;
    if (initialDecision.status === 'denied') return initialDecision;
    return finalDecision;
  };
  return Object.freeze({
    instanceLease: decideLease(initialLease, finalLease),
    runtimeBinding: stableDecision(
      decideRuntimeBinding(
        parseInspection(initial.runtimeBinding),
        input.scope,
        initialLease,
        input.nowMs
      ),
      decideRuntimeBinding(
        parseInspection(final.runtimeBinding),
        input.scope,
        finalLease,
        input.nowMs
      )
    ),
    workspaceBinding: stableDecision(
      decideWorkspaceBinding(parseInspection(initial.workspaceBinding), input.scope, input.nowMs),
      decideWorkspaceBinding(parseInspection(final.workspaceBinding), input.scope, input.nowMs)
    ),
    storage: stableDecision(
      decideStorage(parseInspection(initial.storage), input.scope, input.nowMs),
      decideStorage(parseInspection(final.storage), input.scope, input.nowMs)
    ),
    filesystem: stableDecision(
      decideFilesystem(parseInspection(initial.filesystem), input.scope, input.nowMs),
      decideFilesystem(parseInspection(final.filesystem), input.scope, input.nowMs)
    ),
    externalWriter: stableDecision(
      decideExternalWriter(parseInspection(initial.externalWriter), input.scope, input.nowMs),
      decideExternalWriter(parseInspection(final.externalWriter), input.scope, input.nowMs)
    ),
    recoveryOutbox: stableDecision(
      decideRecoveryOutbox(parseInspection(initial.recoveryOutbox), input.scope, input.nowMs),
      decideRecoveryOutbox(parseInspection(final.recoveryOutbox), input.scope, input.nowMs)
    ),
  });
}

export function mutationReadinessDiagnosticCodes(
  decisions: MutationReadinessDecisions
): readonly MutationReadinessDiagnosticCode[] {
  return Object.freeze(MUTATION_READINESS_DIMENSIONS.map((dimension) => decisions[dimension].code));
}
