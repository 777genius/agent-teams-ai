import type {
  CoordinationEventScope,
  CoordinationJsonValue,
  CoordinationResourceRevision,
  ReplayCursor,
} from './coordinationEventContracts';
import type { TeamId } from '@shared/contracts/hosted';

export const HOSTED_COORDINATION_EVENT_STREAM_ROUTE = '/api/hosted/v1/events' as const;
export const HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION = 1 as const;
export const HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE = '/api/hosted/v1/events/bootstrap' as const;
export const HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface HostedCoordinationEventBootstrapRequest {
  readonly schemaVersion: typeof HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION;
  readonly teamId: TeamId;
}

/**
 * Closed snapshot carried by the shared lower-barrier handoff. Task and inbox
 * state are deliberately fetched through their own bounded page contracts.
 */
export interface HostedCoordinationEventBootstrapSnapshot {
  readonly schemaVersion: typeof HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION;
  readonly kind: 'team_event_bootstrap';
  readonly teamId: TeamId;
}

export const HOSTED_COORDINATION_EVENT_SSE_EVENT = 'coordination_event' as const;
export const HOSTED_COORDINATION_RESYNC_SSE_EVENT = 'resync_required' as const;

export const HOSTED_COORDINATION_RESYNC_REASONS = Object.freeze([
  'malformed_cursor',
  'foreign_deployment',
  'foreign_epoch',
  'cursor_expired',
  'cursor_ahead',
  'event_gap',
  'projection_invalid',
] as const);

export type HostedCoordinationResyncReason = (typeof HOSTED_COORDINATION_RESYNC_REASONS)[number];

/**
 * Scope-authorized projection returned by the hosted access boundary. Journal
 * identity and cursor fields are deliberately absent so the HTTP adapter, not
 * a projector, remains their authority.
 */
export interface HostedCoordinationEventProjection<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly scope: CoordinationEventScope;
  readonly eventType: string;
  readonly resourceRevision?: CoordinationResourceRevision;
  /** Explicit allowlisted browser payload produced by the authorization boundary. */
  readonly publicPayload: TPayload;
}

/**
 * Browser-safe event envelope. Actor attribution, raw workspace paths, command
 * bodies, and provider payloads are never part of this transport contract.
 * `previousEventCursor` permits gap detection without decoding opaque cursors.
 */
export interface HostedCoordinationEventEnvelope<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly schemaVersion: typeof HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION;
  readonly kind: typeof HOSTED_COORDINATION_EVENT_SSE_EVENT;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventSequence: number;
  readonly eventId: string;
  readonly previousEventCursor: ReplayCursor;
  readonly eventCursor: ReplayCursor;
  readonly scope: CoordinationEventScope;
  readonly eventType: string;
  readonly resourceRevision?: CoordinationResourceRevision;
  readonly emittedAt: string;
  readonly payload: TPayload;
}

export interface HostedCoordinationResyncRequired {
  readonly schemaVersion: typeof HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION;
  readonly kind: typeof HOSTED_COORDINATION_RESYNC_SSE_EVENT;
  readonly reason: HostedCoordinationResyncReason;
}

export type HostedCoordinationEventStreamMessage =
  | HostedCoordinationEventEnvelope
  | HostedCoordinationResyncRequired;
