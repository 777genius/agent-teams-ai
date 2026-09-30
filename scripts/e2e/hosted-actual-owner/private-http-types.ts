import type { RawRecord } from './contracts';
import type { ConnectedHttpPeer, HostedHttpContext, LocatedHttpRawRecord } from './raw-http-types';
export const PRIVATE_SUPERVISED_PROVIDER_OPERATIONS = Object.freeze([
  'config', 'config-providers', 'providers', 'provider-auth-methods', 'agents', 'mcp-read', 'mcp-add', 'mcp-connect',
] as const);
export const PRIVATE_HTTP_KIND = 'opencode-http-private-observation/v1' as const
export const PRIVATE_HTTP_PURPOSE = 'agent-teams.p3c.opencode-http-private-observation/v1' as const
export const PRIVATE_HTTP_DOMAIN = `${PRIVATE_HTTP_PURPOSE}\0`
export type PrivateHttpOperationName = typeof PRIVATE_SUPERVISED_PROVIDER_OPERATIONS[number]
export type PrivateHttpBody = Readonly<{ byteLength: number; hmacSha256: string }>
type PrivateHttpCommon = Readonly<{ ownerExchangeNonce: string; operation: PrivateHttpOperationName }>
export type PrivateHttpObservation =
  | (PrivateHttpCommon & Readonly<{ phase: 'request-retained'; method: 'GET' | 'POST'; privateBody: PrivateHttpBody }>)
  | (PrivateHttpCommon & Readonly<{ phase: 'response-retained'; requestRecordId: string; status: number;
      connectedPeer: ConnectedHttpPeer; complete: boolean;
      encoding: 'absent' | 'identity' | 'unexpected'; nonceStatus: 'present' | 'missing' | 'invalid'; privateBody: PrivateHttpBody }>)
  | (PrivateHttpCommon & Readonly<{ phase: 'exchange-failed'; requestRecordId: string;
      failure: Readonly<{phase: 'before-end' | 'end-attempted' | 'response-incomplete'; code: 'http_exchange_failed'}>;
      privateBody: null }>)
export type PrivateHttpRecord = Readonly<{ schemaVersion: 1; purpose: typeof PRIVATE_HTTP_PURPOSE;
  context: HostedHttpContext; observation: PrivateHttpObservation }>
export type PrivateHttpPayload = Readonly<{kind: typeof PRIVATE_HTTP_KIND; recordBase64: string; recordSha256: string}>


export type ParsedPrivateHttpRawRecord = RawRecord & { readonly kind: typeof PRIVATE_HTTP_KIND; readonly http: PrivateHttpRecord };
export type LocatedPrivateHttpRawRecord = ParsedPrivateHttpRawRecord & { readonly byteStart: number; readonly byteEnd: number; readonly lineSha256: string };
export type LocatedHttpObservation = LocatedHttpRawRecord | LocatedPrivateHttpRawRecord;
