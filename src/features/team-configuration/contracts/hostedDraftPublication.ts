import { parseTeamId, parseWorkspaceId, type TeamId, type WorkspaceId } from '@shared/contracts/hosted';

import { type HostedTeamConfigurationErrorResult, parseHostedTeamConfigurationIdempotencyKey } from './hosted';

export interface HostedDraftPublicationStatus {
  readonly operationId: string;
  readonly state: 'pending' | 'published' | 'recovery_required' | 'tombstoned';
}

export function parseHostedDraftPublicationStatus(value: unknown): HostedDraftPublicationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('draft-publication-status-invalid');
  const input = value as Record<string, unknown>;
  if (Reflect.ownKeys(input).length !== 2 || typeof input.operationId !== 'string' ||
      !/^adoption_[a-f0-9]{32}$/.test(input.operationId) ||
      typeof input.state !== 'string' || !['pending', 'published', 'recovery_required', 'tombstoned'].includes(input.state)) {
    throw new TypeError('draft-publication-status-invalid');
  }
  return Object.freeze({ operationId: input.operationId, state: input.state as HostedDraftPublicationStatus['state'] });
}

/** Lookup is one known create operation, never a second team catalog. */
export interface HostedDraftPublicationLookup {
  readonly workspaceId: WorkspaceId;
  readonly reference: { readonly operationId: string } | { readonly idempotencyKey: string };
}
export function parseHostedDraftPublicationLookup(value: unknown): HostedDraftPublicationLookup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('draft-publication-lookup-invalid');
  const input = value as Record<string, unknown>;
  const key = Object.hasOwn(input, 'operationId') ? 'operationId' : 'idempotencyKey';
  if (input.schemaVersion !== 1 || Reflect.ownKeys(input).length !== 3 ||
      Reflect.ownKeys(input).some((name) => !['schemaVersion', 'workspaceId', key].includes(String(name)))) {
    throw new TypeError('draft-publication-lookup-invalid');
  }
  return { workspaceId: parseWorkspaceId(input.workspaceId), reference: key === 'operationId'
    ? { operationId: parseHostedDraftPublicationStatus({ operationId: input.operationId, state: 'pending' }).operationId }
    : { idempotencyKey: parseHostedTeamConfigurationIdempotencyKey(input.idempotencyKey) } };
}
export type HostedDraftPublicationLookupResult =
  | { readonly schemaVersion: 1; readonly kind: 'publication'; readonly teamId: TeamId; readonly publication: HostedDraftPublicationStatus }
  | HostedTeamConfigurationErrorResult;

export function publicationLookupResult(teamId: unknown, publication: unknown): HostedDraftPublicationLookupResult {
  return { schemaVersion: 1, kind: 'publication', teamId: parseTeamId(teamId), publication: parseHostedDraftPublicationStatus(publication) };
}
