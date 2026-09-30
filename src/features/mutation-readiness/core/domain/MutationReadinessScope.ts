import {
  parseDeclaredRootHash,
  parseRegistrationRevision,
  parseWorkspaceMountBindingRef,
  type WorkspaceMountBindingRef,
} from '@features/workspace-registry/contracts';

import {
  MAX_MUTATION_READINESS_ASSESSMENT_TIMEOUT_MS,
  type MutationReadinessRequirements,
  type MutationReadinessWorkspaceTarget,
} from '../../contracts';

import type { RuntimeRootReference } from '@features/runtime-instance-context/contracts';

export function readExactRecord(
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

export function parseWorkspaceRootReference(
  value: unknown
): RuntimeRootReference<'workspace'> | null {
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

export function parseWorkspaceBinding(value: unknown): WorkspaceMountBindingRef | null {
  if (!readExactRecord(value, ['workspaceId', 'bootId', 'mountGeneration'])) return null;
  try {
    return parseWorkspaceMountBindingRef(value);
  } catch {
    return null;
  }
}

export function snapshotWorkspaceTarget(value: unknown): MutationReadinessWorkspaceTarget | null {
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

export function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
