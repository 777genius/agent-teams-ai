import type { MatrixRow, RawRecord } from './contracts';

export const HTTP_OBSERVATION_KIND = 'opencode-http-observation/v1' as const;
export const HTTP_OBSERVATION_PURPOSE = 'agent-teams.p3c.opencode-http-observation/v1' as const;
export const HTTP_LIMITS = Object.freeze({
  body: 1024 * 1024,
  metadata: 64 * 1024,
  record: 2 * 1024 * 1024,
  payload: 2 * 1024 * 1024,
  line: 4 * 1024 * 1024,
  ledger: 64 * 1024 * 1024,
});

// Wire counterparts of r892 OpenCodeHostedRawRetention / ExpectedSupervisedOpenCode.
// These are parsed data, with no custody, activation or acceptance brand.
export type HostedHttpOperation =
  | Readonly<{ kind: 'capability' }>
  | Readonly<{ kind: 'observe'; sessionId: string }>
  | Readonly<{
      kind: 'reply';
      sessionId: string;
      requestId: string;
      runtimeInstanceId: string;
      configGeneration: string;
      sessionIncarnation: string;
      requestIncarnation: string;
      permissionDigest: string;
      decision: 'allow_once' | 'reject';
    }>;

export interface RetainedHttpBody {
  readonly byteLength: number;
  readonly sha256: string;
  readonly bodyBase64: string;
}

export interface ConnectedHttpPeer {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export interface HostedHttpContext {
  readonly bootstrapV2HeaderSha256: string;
  readonly expectedHostSha256: string;
  readonly descriptorMapSha256: string;
  readonly captureId: string;
  readonly row: MatrixRow;
  readonly routeId: string | null;
  readonly activation: Readonly<{
    controllerNonce: string;
    runId: string;
    stackManifestSha256: string;
    bootstrapDigest: string;
    admissionDocumentDigest: string;
    ownerArtifactDigest: string;
    ownerGeneration: number;
    ownerSessionId: string;
  }>;
  readonly recorder: Readonly<{
    role: 'owner';
    pid: number;
    startTicks: string;
    processStartToken: string;
    ownerGeneration: number;
    ownerSessionId: string;
  }>;
  readonly expectedPeer: Readonly<{
    pid: number;
    startTicks: string;
    startIdentity: string;
    supervisorProcessStartToken: string;
    pidNamespaceInode: string;
    networkNamespaceInode: string;
  }>;
}

export interface HttpRequestObservation {
  readonly phase: 'request-retained';
  readonly ownerExchangeNonce: string;
  readonly operation: HostedHttpOperationV2;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body: RetainedHttpBody;
}

export interface HttpResponseObservation {
  readonly phase: 'response-retained';
  readonly ownerExchangeNonce: string;
  readonly requestRecordId: string;
  readonly status: number;
  readonly responseHeaders: readonly (readonly [string, string])[];
  readonly peerOperationNonce: string | null;
  readonly nonceStatus: 'present' | 'missing' | 'invalid';
  readonly connectedPeer: ConnectedHttpPeer;
  readonly body: RetainedHttpBody;
  readonly complete: boolean;
}

export interface HttpFailureObservation {
  readonly phase: 'exchange-failed';
  readonly ownerExchangeNonce: string | null;
  readonly requestRecordId: string | null;
  readonly failure: Readonly<{
    phase: 'before-end' | 'end-attempted' | 'response-incomplete';
    code: string;
  }>;
}

export interface HostedHttpRecordV1 {
  readonly schemaVersion: 1;
  readonly purpose: typeof HTTP_OBSERVATION_PURPOSE;
  readonly context: HostedHttpContext;
  readonly observation: (Omit<HttpRequestObservation, 'operation'> & { readonly operation: HostedHttpOperation }) | HttpResponseObservation | HttpFailureObservation;
}

export const HTTP_OBSERVATION_KIND_V2 = 'opencode-http-observation/v2' as const;
export const HTTP_OBSERVATION_PURPOSE_V2 = 'agent-teams.p3c.opencode-http-observation/v2' as const;
export type SupervisedProviderOperationName =
  | 'health' | 'config' | 'config-providers' | 'providers' | 'provider-auth-methods'
  | 'server-doc' | 'agents' | 'mcp-read' | 'mcp-add' | 'mcp-connect'
  | 'session-create' | 'session-status' | 'session-read' | 'message-read'
  | 'messages-read' | 'message-send' | 'prompt-async' | 'session-abort' | 'tool-ids' | 'tools';
export type HostedHttpOperationV2 = HostedHttpOperation
  | Readonly<{ kind: 'provider'; name: SupervisedProviderOperationName; method: 'GET' | 'POST'; path: string }>
  | Readonly<{ kind: 'events'; path: '/event' | '/global/event' }>
  | Readonly<{ kind: 'transcript'; sessionId: string; limit: 50 }>;
export interface HostedHttpRecordV2 {
  readonly schemaVersion: 2;
  readonly purpose: typeof HTTP_OBSERVATION_PURPOSE_V2;
  readonly context: HostedHttpContext;
  readonly observation: HttpRequestObservation | HttpResponseObservation | HttpFailureObservation;
}
export type HostedHttpRecord = HostedHttpRecordV1;
export type SupportedHostedHttpRecord = HostedHttpRecordV1 | HostedHttpRecordV2;
export type ParsedHttpRawRecord = RawRecord & (
  | { readonly kind: typeof HTTP_OBSERVATION_KIND; readonly http: HostedHttpRecordV1 }
  | { readonly kind: typeof HTTP_OBSERVATION_KIND_V2; readonly http: HostedHttpRecordV2 }
);
export type LocatedHttpRawRecord = ParsedHttpRawRecord & {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineSha256: string;
};
export function isHttpObservationKind(value: unknown): value is ParsedHttpRawRecord['kind'] {
  return value === HTTP_OBSERVATION_KIND || value === HTTP_OBSERVATION_KIND_V2;
}
