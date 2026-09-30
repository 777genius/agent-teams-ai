import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';

import type {
  RuntimeInstanceContext,
  RuntimeRootKind,
  RuntimeRootReference,
  RuntimeRootReferenceValue,
} from '../../contracts/runtime-instance-context';

const CONTEXT_KEYS = [
  'deploymentId',
  'bootId',
  'claudeRoot',
  'appDataRoot',
  'workspaceRoots',
  'tempRoot',
  'logsRoot',
] as const;
const ROOT_REFERENCE_KEYS = ['kind', 'reference'] as const;
const MAX_ROOT_REFERENCE_LENGTH = 4_096;
const MAX_WORKSPACE_ROOTS = 1_000;
const INVALID_CONTEXT = 'runtime-instance-context-invalid';

function invalidContext(): TypeError {
  return new TypeError(INVALID_CONTEXT);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function readExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidContext();
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidContext();
  }

  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw invalidContext();
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidContext();
    }
    snapshot[key] = descriptor.value;
  }

  return snapshot;
}

function parseRootReference<Kind extends RuntimeRootKind>(
  value: unknown,
  expectedKind: Kind
): RuntimeRootReference<Kind> {
  const record = readExactRecord(value, ROOT_REFERENCE_KEYS);
  const reference = record.reference;
  if (
    record.kind !== expectedKind ||
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > MAX_ROOT_REFERENCE_LENGTH ||
    reference.trim() !== reference ||
    hasControlCharacter(reference)
  ) {
    throw invalidContext();
  }

  return Object.freeze({
    kind: expectedKind,
    reference: reference as RuntimeRootReferenceValue,
  });
}

function parseWorkspaceRoots(value: unknown): readonly RuntimeRootReference<'workspace'>[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_WORKSPACE_ROOTS
  ) {
    throw invalidContext();
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
    throw invalidContext();
  }

  const roots: RuntimeRootReference<'workspace'>[] = [];
  roots.length = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidContext();
    }
    roots[index] = parseRootReference(descriptor.value, 'workspace');
  }

  return Object.freeze(roots);
}

export function createRuntimeInstanceContext(value: unknown): RuntimeInstanceContext {
  try {
    const record = readExactRecord(value, CONTEXT_KEYS);
    return Object.freeze({
      deploymentId: parseDeploymentId(record.deploymentId),
      bootId: parseBootId(record.bootId),
      claudeRoot: parseRootReference(record.claudeRoot, 'claude'),
      appDataRoot: parseRootReference(record.appDataRoot, 'app-data'),
      workspaceRoots: parseWorkspaceRoots(record.workspaceRoots),
      tempRoot: parseRootReference(record.tempRoot, 'temp'),
      logsRoot: parseRootReference(record.logsRoot, 'logs'),
    });
  } catch {
    throw invalidContext();
  }
}
