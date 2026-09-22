import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import { parseTeamId } from '@shared/contracts/hosted';

import {
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
} from '../../contracts';

import type {
  CoordinationResourceRevision,
  CoordinationSnapshotEnvelope,
  HostedCoordinationEventBootstrapSnapshot,
  ReplayCursor,
} from '../../contracts';
import type { HostedCoordinationSnapshotResyncPort } from '../ports/HostedCoordinationEventRendererPorts';
import type { HostedCoordinationSnapshotResyncInput } from '../ports/HostedCoordinationEventRendererPorts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_REVISION_VECTOR_LENGTH = 10_000;

export interface HostedCoordinationEventBootstrapHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedCoordinationEventBootstrapHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedCoordinationEventBootstrapFetchPort = (
  input: string,
  init: HostedCoordinationEventBootstrapHttpRequestInit
) => Promise<HostedCoordinationEventBootstrapHttpResponse>;

export interface HostedCoordinationEventBootstrapTransportDependencies {
  readonly fetch: HostedCoordinationEventBootstrapFetchPort;
  readonly getCsrfToken: () => string | null;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function parseReplayCursor(value: unknown): ReplayCursor | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
    ? (value as ReplayCursor)
    : null;
}

function parseRevisionVector(value: unknown): readonly CoordinationResourceRevision[] | null {
  if (!Array.isArray(value) || value.length > MAX_REVISION_VECTOR_LENGTH) return null;
  const resourceKeys = new Set<string>();
  const revisions: CoordinationResourceRevision[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['resourceKey', 'generation', 'revision']) ||
      !validIdentifier(item.resourceKey) ||
      !Number.isSafeInteger(item.generation) ||
      (item.generation as number) < 0 ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 0 ||
      resourceKeys.has(item.resourceKey)
    ) {
      return null;
    }
    resourceKeys.add(item.resourceKey);
    revisions.push(
      Object.freeze({
        resourceKey: item.resourceKey,
        generation: item.generation as number,
        revision: item.revision as number,
      })
    );
  }
  return Object.freeze(revisions);
}

function parseBootstrapEnvelope(
  value: unknown,
  requestedTeamId: string
): CoordinationSnapshotEnvelope<HostedCoordinationEventBootstrapSnapshot> | null {
  if (!isRecord(value) || !hasExactKeys(value, ['metadata', 'snapshot'])) return null;
  const metadata = value.metadata;
  const snapshot = value.snapshot;
  if (
    !isRecord(metadata) ||
    !hasExactKeys(metadata, [
      'schemaVersion',
      'deploymentId',
      'eventEpoch',
      'handoffMode',
      'replayCursor',
      'revisionVector',
    ]) ||
    metadata.schemaVersion !== COORDINATION_SNAPSHOT_SCHEMA_VERSION ||
    !validIdentifier(metadata.deploymentId) ||
    !validIdentifier(metadata.eventEpoch) ||
    metadata.handoffMode !== 'lower_barrier' ||
    !isRecord(snapshot) ||
    !hasExactKeys(snapshot, ['schemaVersion', 'kind', 'teamId']) ||
    snapshot.schemaVersion !== HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION ||
    snapshot.kind !== 'team_event_bootstrap'
  ) {
    return null;
  }
  const replayCursor = parseReplayCursor(metadata.replayCursor);
  const revisionVector = parseRevisionVector(metadata.revisionVector);
  let teamId;
  try {
    teamId = parseTeamId(snapshot.teamId);
  } catch {
    return null;
  }
  if (replayCursor === null || revisionVector === null || teamId !== requestedTeamId) return null;
  return Object.freeze({
    metadata: Object.freeze({
      schemaVersion: COORDINATION_SNAPSHOT_SCHEMA_VERSION,
      deploymentId: metadata.deploymentId,
      eventEpoch: metadata.eventEpoch,
      handoffMode: 'lower_barrier',
      replayCursor,
      revisionVector,
    }),
    snapshot: Object.freeze({
      schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
      kind: 'team_event_bootstrap',
      teamId,
    }),
  });
}

export function createHostedCoordinationEventBootstrapTransport(
  dependencies: HostedCoordinationEventBootstrapTransportDependencies
): HostedCoordinationSnapshotResyncPort<HostedCoordinationEventBootstrapSnapshot> {
  if (!dependencies?.fetch || !dependencies.getCsrfToken) {
    throw new TypeError('hosted-coordination-event-bootstrap-dependencies-invalid');
  }
  return Object.freeze({
    async loadSnapshot({ scope, signal }: HostedCoordinationSnapshotResyncInput) {
      if (scope.kind !== 'team') {
        throw new Error('hosted-coordination-event-bootstrap-scope-invalid');
      }
      const teamId = parseTeamId(scope.scopeId);
      const csrfToken = dependencies.getCsrfToken();
      if (csrfToken === null) {
        throw new Error('hosted-coordination-event-bootstrap-csrf-unavailable');
      }
      const response = await dependencies.fetch(HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: Object.freeze({
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [HOSTED_AUTH_HEADERS.csrf]: csrfToken,
        }),
        body: JSON.stringify({
          schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
          teamId,
        }),
        signal,
      });
      if (response.status !== 200) {
        throw new Error('hosted-coordination-event-bootstrap-unavailable');
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error('hosted-coordination-event-bootstrap-response-invalid');
      }
      const envelope = parseBootstrapEnvelope(value, teamId);
      if (envelope === null) {
        throw new Error('hosted-coordination-event-bootstrap-response-invalid');
      }
      return envelope;
    },
  });
}
