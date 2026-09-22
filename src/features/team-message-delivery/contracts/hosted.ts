import {
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  type Revision,
  type SafeAppError,
  type TeamId,
} from '@shared/contracts/hosted';

declare const hostedMessageBrand: unique symbol;

type HostedMessageOpaqueValue<Name extends string> = string & {
  readonly [hostedMessageBrand]: Name;
};

/** A server-issued opaque identifier for one browser-visible message. */
export type HostedMessageId = HostedMessageOpaqueValue<'HostedMessageId'>;
/** A browser-generated identity used to make one send request idempotent. */
export type HostedClientMessageId = HostedMessageOpaqueValue<'HostedClientMessageId'>;
/** An opaque snapshot identity that binds a page continuation to its source. */
export type HostedMessageSourceGeneration =
  HostedMessageOpaqueValue<'HostedMessageSourceGeneration'>;

export const HOSTED_TEAM_MESSAGE_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_MESSAGE_SCHEMA_VERSION = HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
/** Browser route paths shared by the hosted server descriptor and browser transport. */
export const HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH = '/api/hosted/v1/team-messages/page' as const;
export const HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH = '/api/hosted/v1/team-messages/send' as const;

const MESSAGE_ID = /^message_[0-9a-f]{32}$/;
const CLIENT_MESSAGE_ID = /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SOURCE_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;

export function parseHostedMessageId(value: unknown): HostedMessageId {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) {
    throw new TypeError('hosted-team-message-id-invalid');
  }
  return value as HostedMessageId;
}

export function parseHostedClientMessageId(value: unknown): HostedClientMessageId {
  if (typeof value !== 'string' || !CLIENT_MESSAGE_ID.test(value)) {
    throw new TypeError('hosted-team-message-client-id-invalid');
  }
  return value as HostedClientMessageId;
}

export function parseHostedMessageSourceGeneration(value: unknown): HostedMessageSourceGeneration {
  if (typeof value !== 'string' || !SOURCE_GENERATION.test(value)) {
    throw new TypeError('hosted-team-message-source-generation-invalid');
  }
  return value as HostedMessageSourceGeneration;
}

export const HOSTED_MESSAGE_DIRECTIONS = Object.freeze(['operator', 'team'] as const);
export type HostedMessageDirection = (typeof HOSTED_MESSAGE_DIRECTIONS)[number];

export interface HostedTeamMessage {
  readonly teamId: TeamId;
  readonly messageId: HostedMessageId;
  /** This is authority-produced display direction, never a browser-provided identity. */
  readonly direction: HostedMessageDirection;
  readonly text: string;
  readonly createdAtMs: number;
}

export interface HostedMessagePageRequest {
  readonly schemaVersion: typeof HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedMessageSourceGeneration | null;
  readonly limit: number;
}

export interface HostedMessagePage {
  readonly schemaVersion: typeof HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
  readonly kind: 'message_page';
  readonly teamId: TeamId;
  readonly sourceGeneration: HostedMessageSourceGeneration;
  readonly revision: Revision;
  /** Source continuation order is preserved exactly; consumers must not reorder this list. */
  readonly messages: readonly HostedTeamMessage[];
  readonly nextCursor: Cursor | null;
}

/** The sole browser write shape: a team, a client identity, and plain text. */
export interface SendHostedTeamMessageCommand {
  readonly schemaVersion: typeof HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly clientMessageId: HostedClientMessageId;
  readonly text: string;
}

export const HOSTED_MESSAGE_RUNTIME_DELIVERY_STATES = Object.freeze([
  'delivered',
  'pending',
  'operator_required',
] as const);
export type HostedMessageRuntimeDeliveryState =
  (typeof HOSTED_MESSAGE_RUNTIME_DELIVERY_STATES)[number];

export interface HostedMessagePersistenceReceipt {
  readonly schemaVersion: typeof HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly messageId: HostedMessageId;
  readonly clientMessageId: HostedClientMessageId;
  readonly persistence: 'durable';
}

export interface HostedTeamMessageSendReceipt extends HostedMessagePersistenceReceipt {
  /** Runtime delivery is deliberately reported separately from durable persistence. */
  readonly runtimeDelivery: HostedMessageRuntimeDeliveryState;
}

export type GetHostedMessagePageResult =
  | { readonly kind: 'success'; readonly page: HostedMessagePage }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedMessageSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export type SendHostedTeamMessageResult =
  | { readonly kind: 'persisted'; readonly receipt: HostedTeamMessageSendReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedTeamMessageSendReceipt }
  | { readonly kind: 'invalid_request' }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTeamMessageErrorEnvelope {
  readonly schemaVersion: typeof HOSTED_TEAM_MESSAGE_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError;
  readonly retryable: boolean;
  readonly currentSourceGeneration?: HostedMessageSourceGeneration;
}

export type HostedTeamMessagePage = HostedMessagePage;
export type HostedMessagePageItem = HostedTeamMessage;
