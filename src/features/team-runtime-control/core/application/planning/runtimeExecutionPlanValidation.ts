import { parseMemberId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  type CredentialExposureSet,
  type ExecutionUnitId,
  HOSTED_CHILD_ENVIRONMENT_PROVENANCE,
  type HostedChildEnvironmentPolicy,
  type HostedChildEnvironmentVariablePolicy,
  type LaneId,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSecretClass,
  parseSecretRefId,
  type ProcessExecutionUnit,
  type RegisteredWorkspaceRuntimeBinding,
  type ResolvedRuntimeBinaryPolicy,
  type RuntimeExecutionBackendBinding,
  type RuntimeExecutionBackendKind,
  type RuntimeLaneKind,
  type RuntimePlanLaneBinding,
  type RuntimePlanMemberBinding,
  type RuntimeResourcePolicy,
  type RuntimeTopologyMode,
  type SecretRefMetadata,
} from '../../../contracts';
import { credentialExposureSetsOverlap, credentialRefKey } from '../../domain/ProcessExecutionUnit';
import { isRuntimeExecutionBackend } from '../../domain/RuntimeExecutionBackend';

import {
  assertExactRecord,
  assertPlainRecord,
  fail,
  isPlainRecord,
  sameStringArray,
  validateDenseArray,
  validateDenseNonEmptyArray,
  validateIdentifier,
  validatePositiveInteger,
  validateSha256Hash,
} from './runtimePlanValidationPrimitives';

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface ResolvedProcessExecutionUnitFact {
  readonly executionUnitId: ExecutionUnitId;
  readonly backendBinding: RuntimeExecutionBackendBinding;
  readonly laneId: LaneId;
  readonly binaryPolicy: ResolvedRuntimeBinaryPolicy;
  readonly environmentPolicy: HostedChildEnvironmentPolicy;
  readonly credentialExposureSet: CredentialExposureSet;
  readonly resourcePolicy: RuntimeResourcePolicy;
}

export function validateResolvedExecutionUnits(
  value: unknown,
  topology: RuntimeTopologyMode,
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): readonly ProcessExecutionUnit[] {
  validateDenseNonEmptyArray(value, 'executionUnits');
  const facts = value;
  if (facts.length !== lanes.length) {
    fail('lane_plan_mismatch', 'runtime-plan-execution-unit-lane-count-mismatch');
  }
  const executionUnitIds = new Set<string>();
  const units = facts.map((candidate, index) => {
    assertExactRecord(
      candidate,
      [
        'backendBinding',
        'binaryPolicy',
        'credentialExposureSet',
        'environmentPolicy',
        'executionUnitId',
        'laneId',
        'resourcePolicy',
      ],
      'executionUnitFact'
    );
    const fact = candidate as unknown as ResolvedProcessExecutionUnitFact;
    validateIdentifier(() => parseExecutionUnitId(fact.executionUnitId), 'executionUnitId');
    if (executionUnitIds.has(fact.executionUnitId)) {
      fail('duplicate_execution_unit_id', 'runtime-plan-execution-unit-id-duplicate');
    }
    executionUnitIds.add(fact.executionUnitId);
    const lane = lanes[index];
    if (fact.laneId !== lane?.laneId) {
      fail('lane_plan_mismatch', 'runtime-plan-execution-unit-lane-order-mismatch');
    }
    const backendBinding = validateBackendBinding(fact.backendBinding);
    if (backendBinding.backend !== expectedBackend(topology, lane.laneKind)) {
      fail('unsupported_topology', 'runtime-plan-execution-backend-topology-unsupported');
    }
    const credentialExposureSet = validateCredentialExposureSet(
      fact.credentialExposureSet,
      'executionUnit.credentialExposureSet'
    );
    validateMinimumCredentialExposure(lane.requiredCredentialExposureSet, credentialExposureSet);
    return {
      executionUnitId: fact.executionUnitId,
      backendBinding,
      laneId: fact.laneId,
      memberIds: Object.freeze([...lane.memberIds]),
      binaryPolicy: validateBinaryPolicy(fact.binaryPolicy),
      environmentPolicy: validateEnvironmentPolicy(fact.environmentPolicy, credentialExposureSet),
      credentialExposureSet,
      resourcePolicy: validateResourcePolicy(fact.resourcePolicy),
    };
  });

  return Object.freeze(
    units.map((unit, unitIndex) => {
      const overlaps = units.some(
        (candidate, candidateIndex) =>
          unitIndex !== candidateIndex &&
          credentialExposureSetsOverlap(unit.credentialExposureSet, candidate.credentialExposureSet)
      );
      const credentialIsolation =
        unit.backendBinding.backend === 'opencode' && unit.memberIds.length === 1 && !overlaps
          ? 'dedicated_execution_unit'
          : 'shared_execution_unit';
      return Object.freeze({ ...unit, credentialIsolation });
    })
  );
}

export function validatePersistedExecutionUnits(
  value: unknown,
  topology: RuntimeTopologyMode,
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): readonly ProcessExecutionUnit[] {
  validateDenseNonEmptyArray(value, 'executionUnits');
  const persistedUnits = value;
  const facts = persistedUnits.map((candidate) => {
    assertExactRecord(
      candidate,
      [
        'backendBinding',
        'binaryPolicy',
        'credentialExposureSet',
        'credentialIsolation',
        'environmentPolicy',
        'executionUnitId',
        'laneId',
        'memberIds',
        'resourcePolicy',
      ],
      'persistedExecutionUnit'
    );
    const unit = candidate as unknown as ProcessExecutionUnit;
    return {
      executionUnitId: unit.executionUnitId,
      backendBinding: unit.backendBinding,
      laneId: unit.laneId,
      binaryPolicy: unit.binaryPolicy,
      environmentPolicy: unit.environmentPolicy,
      credentialExposureSet: unit.credentialExposureSet,
      resourcePolicy: unit.resourcePolicy,
    };
  });
  const units = validateResolvedExecutionUnits(facts, topology, members, lanes);
  units.forEach((unit, index) => {
    const persisted = persistedUnits[index] as ProcessExecutionUnit;
    validateDenseArray(persisted.memberIds, 'executionUnit.memberIds');
    persisted.memberIds.forEach((memberId) =>
      validateIdentifier(() => parseMemberId(memberId), 'executionUnit.memberId')
    );
    if (!sameStringArray(persisted.memberIds, unit.memberIds)) {
      fail('persisted_plan_invalid', 'runtime-plan-execution-unit-members-not-derived');
    }
    if (persisted.credentialIsolation !== unit.credentialIsolation) {
      fail('persisted_plan_invalid', 'runtime-plan-credential-isolation-not-derived');
    }
  });
  return units;
}

function validateBackendBinding(value: unknown): RuntimeExecutionBackendBinding {
  assertExactRecord(value, ['backend', 'bindingId', 'bindingRevision'], 'backendBinding');
  const binding = value as unknown as RuntimeExecutionBackendBinding;
  if (!isRuntimeExecutionBackend(binding.backend)) {
    fail('unsupported_topology', 'runtime-plan-execution-backend-unsupported');
  }
  validateIdentifier(() => parseRuntimeBackendBindingId(binding.bindingId), 'bindingId');
  validatePositiveInteger(binding.bindingRevision, 'bindingRevision');
  return Object.freeze({
    backend: binding.backend,
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
  });
}

function validateBinaryPolicy(value: unknown): ResolvedRuntimeBinaryPolicy {
  assertExactRecord(value, ['binaryHash', 'binaryId', 'binaryRevision', 'policy'], 'binaryPolicy');
  const policy = value as unknown as ResolvedRuntimeBinaryPolicy;
  if (policy.policy !== 'registered_exact_binary') {
    fail('invalid_field', 'runtime-plan-binary-policy-unsupported');
  }
  validateIdentifier(() => parseRuntimeBinaryId(policy.binaryId), 'binaryId');
  validatePositiveInteger(policy.binaryRevision, 'binaryRevision');
  return Object.freeze({
    policy: policy.policy,
    binaryId: policy.binaryId,
    binaryRevision: policy.binaryRevision,
    binaryHash: validateSha256Hash(policy.binaryHash, 'binaryHash'),
  });
}

export function validateWorkspaceBinding(value: unknown): RegisteredWorkspaceRuntimeBinding {
  assertExactRecord(
    value,
    ['bindingGeneration', 'mountGeneration', 'registrationRevision', 'workspaceId'],
    'workspaceBinding'
  );
  const binding = value as unknown as RegisteredWorkspaceRuntimeBinding;
  validateIdentifier(() => parseWorkspaceId(binding.workspaceId), 'workspaceId');
  validatePositiveInteger(binding.registrationRevision, 'registrationRevision');
  validatePositiveInteger(binding.bindingGeneration, 'bindingGeneration');
  validatePositiveInteger(binding.mountGeneration, 'mountGeneration');
  return Object.freeze({
    workspaceId: binding.workspaceId,
    registrationRevision: binding.registrationRevision,
    bindingGeneration: binding.bindingGeneration,
    mountGeneration: binding.mountGeneration,
  });
}

export function validateCredentialExposureSet(
  value: unknown,
  field: string
): CredentialExposureSet {
  assertExactRecord(value, ['secretRefs'], field);
  const exposureSet = value as unknown as CredentialExposureSet;
  validateDenseArray(exposureSet.secretRefs, `${field}.secretRefs`);
  const seenSecretRefIds = new Set<string>();
  let previousKey: string | null = null;
  const secretRefs = exposureSet.secretRefs.map((secretRef) => {
    const validated = validateSecretRef(secretRef, `${field}.secretRef`);
    const key = credentialRefKey(validated);
    if (seenSecretRefIds.has(validated.secretRefId)) {
      fail('invalid_field', 'runtime-plan-credential-ref-duplicate');
    }
    if (previousKey !== null && previousKey >= key) {
      fail('unstable_ordering', 'runtime-plan-credential-order-unstable');
    }
    seenSecretRefIds.add(validated.secretRefId);
    previousKey = key;
    return validated;
  });
  return Object.freeze({ secretRefs: Object.freeze(secretRefs) });
}

function validateSecretRef(value: unknown, field: string): SecretRefMetadata {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'secretClass,secretRefId') {
    fail('credential_metadata_only', 'runtime-plan-credential-metadata-only');
  }
  const secretRef = value as unknown as SecretRefMetadata;
  validateIdentifier(() => parseSecretRefId(secretRef.secretRefId), `${field}.secretRefId`);
  validateIdentifier(() => parseSecretClass(secretRef.secretClass), `${field}.secretClass`);
  return Object.freeze({
    secretRefId: secretRef.secretRefId,
    secretClass: secretRef.secretClass,
  });
}

function validateEnvironmentPolicy(
  value: unknown,
  credentialExposureSet: CredentialExposureSet
): HostedChildEnvironmentPolicy {
  assertExactRecord(value, ['policy', 'variables'], 'environmentPolicy');
  const policy = value as unknown as HostedChildEnvironmentPolicy;
  if (policy.policy !== 'explicit_allowlist') {
    fail('invalid_field', 'runtime-plan-environment-policy-unsupported');
  }
  validateDenseArray(policy.variables, 'environmentPolicy.variables');
  const allowedSecretRefs = new Set(credentialExposureSet.secretRefs.map(credentialRefKey));
  const names = new Set<string>();
  let previousName: string | null = null;
  const variables = policy.variables.map((candidate) => {
    assertPlainRecord(candidate, 'environmentVariable');
    const variable = candidate as HostedChildEnvironmentVariablePolicy;
    const secretProvenance = variable.provenance === 'secret_ref';
    assertExactRecord(
      candidate,
      secretProvenance ? ['name', 'provenance', 'secretRef'] : ['name', 'provenance'],
      'environmentVariable'
    );
    if (typeof variable.name !== 'string' || !ENVIRONMENT_NAME_PATTERN.test(variable.name)) {
      fail('invalid_field', 'runtime-plan-environment-name-invalid');
    }
    if (
      !(HOSTED_CHILD_ENVIRONMENT_PROVENANCE as readonly unknown[]).includes(variable.provenance)
    ) {
      fail('invalid_field', 'runtime-plan-environment-provenance-invalid');
    }
    if (names.has(variable.name)) {
      fail('invalid_field', 'runtime-plan-environment-name-duplicate');
    }
    if (previousName !== null && previousName >= variable.name) {
      fail('unstable_ordering', 'runtime-plan-environment-order-unstable');
    }
    names.add(variable.name);
    previousName = variable.name;
    if (secretProvenance) {
      const secretRef = validateSecretRef(variable.secretRef, 'environmentVariable.secretRef');
      if (!allowedSecretRefs.has(credentialRefKey(secretRef))) {
        fail('credential_exposure_widened', 'runtime-plan-environment-secret-not-exposed');
      }
      return Object.freeze({
        name: variable.name,
        provenance: variable.provenance,
        secretRef,
      });
    }
    return Object.freeze({ name: variable.name, provenance: variable.provenance });
  });
  return Object.freeze({ policy: 'explicit_allowlist', variables: Object.freeze(variables) });
}

function validateResourcePolicy(value: unknown): RuntimeResourcePolicy {
  assertExactRecord(
    value,
    ['gracefulStopMs', 'maxOutputBytes', 'maxProcessCount', 'maxRuntimeMs'],
    'resourcePolicy'
  );
  const policy = value as unknown as RuntimeResourcePolicy;
  validatePositiveInteger(policy.maxRuntimeMs, 'resourcePolicy.maxRuntimeMs');
  validatePositiveInteger(policy.gracefulStopMs, 'resourcePolicy.gracefulStopMs');
  validatePositiveInteger(policy.maxOutputBytes, 'resourcePolicy.maxOutputBytes');
  validatePositiveInteger(policy.maxProcessCount, 'resourcePolicy.maxProcessCount');
  if (policy.gracefulStopMs > policy.maxRuntimeMs) {
    fail('invalid_field', 'runtime-plan-resource-grace-exceeds-runtime');
  }
  return Object.freeze({
    maxRuntimeMs: policy.maxRuntimeMs,
    gracefulStopMs: policy.gracefulStopMs,
    maxOutputBytes: policy.maxOutputBytes,
    maxProcessCount: policy.maxProcessCount,
  });
}

export function validateSecretRefClassConsistency(
  exposureSets: readonly CredentialExposureSet[]
): void {
  const classBySecretRefId = new Map<string, string>();
  for (const exposureSet of exposureSets) {
    for (const secretRef of exposureSet.secretRefs) {
      const knownClass = classBySecretRefId.get(secretRef.secretRefId);
      if (knownClass !== undefined && knownClass !== secretRef.secretClass) {
        fail('invalid_field', 'runtime-plan-secret-ref-class-conflict');
      }
      classBySecretRefId.set(secretRef.secretRefId, secretRef.secretClass);
    }
  }
}

function validateMinimumCredentialExposure(
  required: CredentialExposureSet,
  actual: CredentialExposureSet
): void {
  const requiredKeys = new Set(required.secretRefs.map(credentialRefKey));
  const actualKeys = new Set(actual.secretRefs.map(credentialRefKey));
  if (actual.secretRefs.some((secretRef) => !requiredKeys.has(credentialRefKey(secretRef)))) {
    fail('credential_exposure_widened', 'runtime-plan-credential-exposure-widened');
  }
  if (required.secretRefs.some((secretRef) => !actualKeys.has(credentialRefKey(secretRef)))) {
    fail('credential_exposure_missing', 'runtime-plan-required-credential-exposure-missing');
  }
}

function expectedBackend(
  topology: RuntimeTopologyMode,
  laneKind: RuntimeLaneKind
): RuntimeExecutionBackendKind {
  if (
    topology === 'pure_opencode' ||
    topology === 'pure_opencode_solo' ||
    topology === 'pure_opencode_member_lanes' ||
    laneKind === 'secondary'
  ) {
    return 'opencode';
  }
  return 'provisioning_cli';
}

export function validatePersistedLaneOrder(
  value: unknown,
  lanes: readonly RuntimePlanLaneBinding[]
): void {
  validateDenseNonEmptyArray(value, 'orderedLaneIds');
  const laneIds = value;
  laneIds.forEach((laneId) => validateIdentifier(() => parseLaneId(laneId), 'orderedLaneId'));
  if (
    !sameStringArray(
      laneIds as readonly string[],
      lanes.map((lane) => lane.laneId)
    )
  ) {
    fail('persisted_plan_invalid', 'runtime-plan-ordered-lanes-not-derived');
  }
}
