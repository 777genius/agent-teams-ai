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
  readonly operation: HostedHttpOperation;
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

export interface HostedHttpRecord {
  readonly schemaVersion: 1;
  readonly purpose: typeof HTTP_OBSERVATION_PURPOSE;
  readonly context: HostedHttpContext;
  readonly observation: HttpRequestObservation | HttpResponseObservation | HttpFailureObservation;
}

export interface ParsedHttpRawRecord extends RawRecord {
  readonly kind: typeof HTTP_OBSERVATION_KIND;
  readonly http: HostedHttpRecord;
}

export interface LocatedHttpRawRecord extends ParsedHttpRawRecord {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineSha256: string;
}
