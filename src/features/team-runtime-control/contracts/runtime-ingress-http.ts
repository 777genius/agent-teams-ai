/**
 * Private machine-ingress transport shapes.
 *
 * This file is deliberately absent from contracts/index.ts. Runtime ingress is
 * not a browser capability and is not part of the generated hosted client.
 */
export const RUNTIME_INGRESS_HTTP_BASE_PATH = '/api/runtime/v1/runs' as const;
export const RUNTIME_INGRESS_HTTP_BODY_LIMIT_BYTES = 64 * 1024;
export const RUNTIME_INGRESS_BEARER_MIN_LENGTH = 43;
export const RUNTIME_INGRESS_BEARER_MAX_LENGTH = 192;

/**
 * Transport adapters must apply this fence to their streaming/body parser
 * before materializing rawBody or invoking RuntimeIngressHttpInputAdapter.
 */
export interface RuntimeIngressHttpPreMaterializationSizeFence {
  readonly maximumBodyBytes: number;
  readonly overflowStatusCode: 413;
  readonly rejectBeforeBodyMaterialization: true;
}

export interface RuntimeIngressHttpCommandBody {
  readonly runtimeInstanceId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly observedAtIso: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RuntimeIngressHttpRequest {
  /** Run path parameter. It is an assertion, never authority. */
  readonly runId: unknown;
  /** Selected by a private static route descriptor, never from body JSON. */
  readonly verb: unknown;
  readonly authorizationHeader?: string | readonly string[];
  readonly credentialIdHeader?: string | readonly string[];
  readonly contentTypeHeader?: string | readonly string[];
  readonly contentLengthHeader?: string | readonly string[];
  readonly cookieHeader?: string | readonly string[];
  readonly rawBody: string | Uint8Array;
}

export interface RuntimeIngressHttpAcknowledgementBody {
  readonly requestId: string;
  readonly status: 'accepted' | 'replayed';
  readonly acknowledgementId: string;
  readonly effectRef: string;
  readonly acceptedAtIso: string;
}

export interface RuntimeIngressHttpErrorBody {
  readonly requestId: string;
  readonly error: {
    readonly code:
      | 'runtime_ingress_bad_request'
      | 'runtime_ingress_unauthorized'
      | 'runtime_ingress_scope_mismatch'
      | 'runtime_ingress_conflict'
      | 'runtime_ingress_payload_too_large'
      | 'runtime_ingress_rate_limited'
      | 'runtime_ingress_recovery_required'
      | 'runtime_ingress_unavailable';
    readonly retryable: boolean;
  };
}

export type RuntimeIngressHttpResponse =
  | {
      readonly statusCode: 200 | 202;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: RuntimeIngressHttpAcknowledgementBody;
    }
  | {
      readonly statusCode: 400 | 401 | 403 | 409 | 413 | 429 | 503;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: RuntimeIngressHttpErrorBody;
    };
