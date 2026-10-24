import { isAbsolute } from 'node:path';

import { hostPayloadLimit, type JsonValue } from '@agent-teams/legacy-agent-host/contracts';

export type { BackendHandle } from '../../contracts';

export interface BackendOwnerRef {
  readonly ownerId: string;
  readonly revision: string;
}

export interface BackendScope {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly memberId: string | null;
  readonly generation: string | number | null;
}

export interface BackendOwnerBinding extends BackendOwnerRef {
  readonly protocolVersion: 1;
  readonly profileId: string;
  readonly buildId: string;
  readonly nodeSha256: string;
  readonly hostEntrySha256: string;
  readonly storageRoot: string;
}

export interface StoredBackendBinding {
  readonly schemaVersion: 1;
  readonly handleId: string;
  readonly owner: BackendOwnerBinding;
  readonly scope: BackendScope;
}

/** Immutable routing metadata only. No command payloads, effects, or outcome journal. */
export interface HandleBindingStore {
  read(handleId: string): Promise<StoredBackendBinding | null>;
  /** Durable no-clobber publication; returns false if this handle already exists. */
  create(binding: StoredBackendBinding): Promise<boolean>;
}

export class BackendRoutingError extends Error {
  constructor(
    readonly code:
      | 'invalid-binding'
      | 'binding-conflict'
      | 'unavailable'
      | 'hold'
      | 'shutting-down'
      | 'forbidden',
    readonly outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'
  ) {
    super(`Backend routing: ${code}`);
    this.name = 'BackendRoutingError';
  }
}

/** Main-owned captured context predicate; never serialized across a transport. */
export interface BackendRequestGuard {
  readonly isCurrent: () => boolean;
}

export function assertBackendRequestGuard(
  guard: BackendRequestGuard | undefined,
  outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'
): void {
  if (!guard) return;
  let current = false;
  try {
    current = guard.isCurrent() === true;
  } catch {
    /* Fail closed without disclosing shell state. */
  }
  if (!current) throw new BackendRoutingError('forbidden', outcome);
}

export function assertIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new BackendRoutingError('invalid-binding');
  }
}

/** Capture an immutable, finite wire intent before any asynchronous selection or startup. */
export function captureBackendPayload(payload: unknown, method?: string): JsonValue {
  try {
    const serialized = JSON.stringify(payload, (_key, value: unknown) => {
      if (
        (typeof value === 'number' && !Number.isFinite(value)) ||
        value === undefined ||
        typeof value === 'bigint' ||
        typeof value === 'function' ||
        typeof value === 'symbol'
      )
        throw new BackendRoutingError('invalid-binding');
      return value;
    });
    if (Buffer.byteLength(serialized, 'utf8') > hostPayloadLimit(method))
      throw new BackendRoutingError('invalid-binding');
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new BackendRoutingError('invalid-binding');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackendRoutingError('invalid-binding');
  }
  return value as Record<string, unknown>;
}

export function captureScope(value: unknown): BackendScope {
  const scope = record(value);
  for (const key of ['projectId', 'workspaceId', 'teamId', 'runId']) assertIdentity(scope[key]);
  if (scope.memberId !== null) assertIdentity(scope.memberId);
  if (
    scope.generation !== null &&
    typeof scope.generation !== 'string' &&
    !(Number.isSafeInteger(scope.generation) && Number(scope.generation) >= 0)
  ) {
    throw new BackendRoutingError('invalid-binding');
  }
  if (typeof scope.generation === 'string') assertIdentity(scope.generation);
  return Object.freeze({
    projectId: scope.projectId as string,
    workspaceId: scope.workspaceId as string,
    teamId: scope.teamId as string,
    runId: scope.runId as string,
    memberId: scope.memberId,
    generation: scope.generation as string | number | null,
  });
}

export function captureOwnerBinding(value: unknown): BackendOwnerBinding {
  const owner = record(value);
  for (const key of ['ownerId', 'revision', 'profileId', 'buildId']) assertIdentity(owner[key]);
  if (
    owner.protocolVersion !== 1 ||
    typeof owner.storageRoot !== 'string' ||
    !isAbsolute(owner.storageRoot) ||
    owner.storageRoot.includes('\0') ||
    [owner.nodeSha256, owner.hostEntrySha256].some(
      (digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
    )
  ) {
    throw new BackendRoutingError('invalid-binding');
  }
  return Object.freeze({
    ownerId: owner.ownerId as string,
    revision: owner.revision as string,
    profileId: owner.profileId as string,
    protocolVersion: 1,
    buildId: owner.buildId as string,
    nodeSha256: owner.nodeSha256 as string,
    hostEntrySha256: owner.hostEntrySha256 as string,
    storageRoot: owner.storageRoot,
  });
}

export function captureStoredBinding(value: unknown): StoredBackendBinding {
  const binding = record(value);
  if (binding.schemaVersion !== 1) throw new BackendRoutingError('invalid-binding');
  assertIdentity(binding.handleId);
  return Object.freeze({
    schemaVersion: 1,
    handleId: binding.handleId,
    owner: captureOwnerBinding(binding.owner),
    scope: captureScope(binding.scope),
  });
}

export function ownerKey(owner: BackendOwnerRef): string {
  assertIdentity(owner.ownerId);
  assertIdentity(owner.revision);
  return JSON.stringify([owner.ownerId, owner.revision]);
}
