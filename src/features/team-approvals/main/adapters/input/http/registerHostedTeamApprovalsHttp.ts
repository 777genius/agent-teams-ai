import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  bindProductHostedProducerOperation,
  type HostedProducerProvenance,
  isHostedProducerProvenanceFatalError,
  type ProductHostedProducerOperation,
  requireProductHostedProducerInstance,
} from '@features/hosted-producer-provenance/main/hosted';
import { createSafeAppError, type QueryContext } from '@shared/contracts/hosted';

import {
  type DecideHostedTeamApprovalResult,
  type GetHostedTeamApprovalPageResult,
  type GetHostedTeamApprovalPreviewResult,
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecision,
  type HostedTeamApprovalErrorEnvelope,
  type HostedTeamApprovalGeneration,
} from '../../../../contracts/hosted';

import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from './hostedTeamApprovalRoutes';

import type {
  HostedRouteAdmission,
  HostedRouteContribution,
} from '@main/composition/hosted/application';
import type { RouteDescriptor } from '@main/composition/hosted/routing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedTeamApprovalsHttpFacade {
  getPage(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPageResult>;
  getPreview(request: unknown, context: QueryContext): Promise<GetHostedTeamApprovalPreviewResult>;
  decide(request: unknown, context: QueryContext): Promise<DecideHostedTeamApprovalResult>;
}

export type HostedTeamApprovalsContextFactory = (
  descriptor: RouteDescriptor,
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

function errorEnvelope(
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable',
  reason: string,
  retryable: boolean,
  metadata: {
    readonly retryAfterMs?: number;
    readonly currentGeneration?: HostedTeamApprovalGeneration;
    readonly resolvedDecision?: HostedTeamApprovalDecision;
  } = {}
): HostedTeamApprovalErrorEnvelope {
  const error = createSafeAppError({
    code,
    reason,
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
  });
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'error',
    error,
    retryable,
    ...(metadata.currentGeneration === undefined
      ? {}
      : { currentGeneration: metadata.currentGeneration }),
    ...(metadata.resolvedDecision === undefined
      ? {}
      : { resolvedDecision: metadata.resolvedDecision }),
  });
}

type PreparedResponseOutcome =
  | 'success'
  | 'committed'
  | 'idempotent_replay'
  | 'already_resolved'
  | 'invalid_request'
  | 'stale_generation'
  | 'conflict'
  | 'expired'
  | 'not_found'
  | 'cancelled'
  | 'unavailable';

interface PreparedResponse {
  readonly status: number;
  readonly outcome: PreparedResponseOutcome;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
}

const rawRequestBodies = new WeakMap<FastifyRequest, Buffer>();
const HOSTED_TEAM_APPROVAL_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;

function requestBodyTooLarge(): Error & { readonly code: string; readonly statusCode: number } {
  return Object.assign(new Error('Hosted team approval request body is too large'), {
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    statusCode: 413,
  });
}

async function captureExactRequestBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: NodeJS.ReadableStream
): Promise<Readable> {
  const contentLength = request.headers['content-length'];
  if (
    typeof contentLength === 'string' &&
    /^(?:0|[1-9][0-9]*)$/u.test(contentLength) &&
    BigInt(contentLength) > BigInt(HOSTED_TEAM_APPROVAL_REQUEST_BODY_LIMIT_BYTES)
  ) {
    throw requestBodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of payload) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > HOSTED_TEAM_APPROVAL_REQUEST_BODY_LIMIT_BYTES) {
      throw requestBodyTooLarge();
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, byteLength);
  rawRequestBodies.set(request, bytes);
  const replay = Readable.from(bytes.byteLength === 0 ? [] : [bytes]);
  Object.assign(replay, { receivedEncodedLength: bytes.byteLength });
  return replay;
}

function unavailableResponse(
  retryAfterMs?: number,
  outcome: 'cancelled' | 'unavailable' = 'unavailable'
): PreparedResponse {
  return Object.freeze({
    status: 503,
    outcome,
    body: errorEnvelope('unavailable', 'team_approval_unavailable', true, { retryAfterMs }),
    ...(retryAfterMs === undefined
      ? {}
      : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)) }),
  });
}

function preparePageResult(result: GetHostedTeamApprovalPageResult): PreparedResponse {
  switch (result.kind) {
    case 'success':
      return Object.freeze({ status: 200, outcome: 'success', body: result.page });
    case 'invalid_request':
      return Object.freeze({
        status: 400,
        outcome: 'invalid_request',
        body: errorEnvelope('invalid_request', 'approval_page_request_invalid', false),
      });
    case 'not_found':
      return Object.freeze({
        status: 404,
        outcome: 'not_found',
        body: errorEnvelope('not_found', 'team_not_found', false),
      });
    case 'cancelled':
      return unavailableResponse(undefined, 'cancelled');
    case 'unavailable':
      return unavailableResponse(result.retryAfterMs);
  }
}

function preparePreviewResult(result: GetHostedTeamApprovalPreviewResult): PreparedResponse {
  switch (result.kind) {
    case 'success':
      return Object.freeze({ status: 200, outcome: 'success', body: result.preview });
    case 'invalid_request':
      return Object.freeze({
        status: 400,
        outcome: 'invalid_request',
        body: errorEnvelope('invalid_request', 'approval_preview_request_invalid', false),
      });
    case 'stale_generation':
      return Object.freeze({
        status: 409,
        outcome: 'stale_generation',
        body: errorEnvelope('conflict', 'stale_generation', false, {
          currentGeneration: result.currentGeneration,
        }),
      });
    case 'not_found':
      return Object.freeze({
        status: 404,
        outcome: 'not_found',
        body: errorEnvelope('not_found', 'approval_not_found', false),
      });
    case 'cancelled':
      return unavailableResponse(undefined, 'cancelled');
    case 'unavailable':
      return unavailableResponse(result.retryAfterMs);
  }
}

function prepareDecisionResult(result: DecideHostedTeamApprovalResult): PreparedResponse {
  switch (result.kind) {
    case 'committed':
    case 'idempotent_replay':
      return Object.freeze({ status: 200, outcome: result.kind, body: result.receipt });
    case 'already_resolved':
      return Object.freeze({
        status: 409,
        outcome: 'already_resolved',
        body: errorEnvelope('conflict', 'approval_already_resolved', false, {
          currentGeneration: result.generation,
          resolvedDecision: result.decision,
        }),
      });
    case 'invalid_request':
      return Object.freeze({
        status: 400,
        outcome: 'invalid_request',
        body: errorEnvelope('invalid_request', 'approval_decision_invalid', false),
      });
    case 'stale_generation':
      return Object.freeze({
        status: 409,
        outcome: 'stale_generation',
        body: errorEnvelope('conflict', 'stale_generation', false, {
          currentGeneration: result.currentGeneration,
        }),
      });
    case 'conflict':
      return Object.freeze({
        status: 409,
        outcome: 'conflict',
        body: errorEnvelope('conflict', result.reason, false),
      });
    case 'expired':
      return Object.freeze({
        status: 410,
        outcome: 'expired',
        body: errorEnvelope('conflict', 'approval_expired', false),
      });
    case 'not_found':
      return Object.freeze({
        status: 404,
        outcome: 'not_found',
        body: errorEnvelope('not_found', 'approval_not_found', false),
      });
    case 'unavailable':
      return unavailableResponse(result.retryAfterMs);
  }
}

function dispatchPreparedResponse(
  reply: FastifyReply,
  descriptor: RouteDescriptor,
  requestBytes: Buffer,
  operation: ProductHostedProducerOperation | null,
  provenance: HostedProducerProvenance,
  response: PreparedResponse
): FastifyReply {
  void reply.status(response.status);
  const serializedResponse = reply.serialize(response.body);
  const responseBytes =
    typeof serializedResponse === 'string' || Buffer.isBuffer(serializedResponse)
      ? Buffer.from(serializedResponse)
      : Buffer.from(new Uint8Array(serializedResponse));
  const instance = requireProductHostedProducerInstance(provenance);
  const operationNative =
    operation === null
      ? null
      : Object.freeze({
          actorId: operation.actorId,
          bootId: operation.bootId,
          deploymentId: operation.deploymentId,
          ownerAuthority: operation.ownerAuthority,
          ownerGeneration: operation.ownerGeneration,
          ownerSessionId: operation.ownerSessionId,
          requestId: operation.requestId,
          sessionId: operation.sessionId,
        });
  const common = Object.freeze({
    ...instance,
    method: 'POST',
    requestBodyBytes: requestBytes.byteLength,
    requestBodySha256: createHash('sha256').update(requestBytes).digest('hex'),
    responseBodyBytes: responseBytes.byteLength,
    responseBodySha256: createHash('sha256').update(responseBytes).digest('hex'),
    routeId: descriptor.id,
  });
  provenance.emit(
    'productTimeline',
    operation === null
      ? {
          recordType: 'approval-http-unadmitted-response-finalized',
          operationNonce: randomBytes(32).toString('hex'),
          native: Object.freeze({ ...common, outcome: 'unadmitted', status: 503 }),
        }
      : {
          recordType: 'approval-http-response-finalized',
          operationNonce: operation.operationNonce,
          native: Object.freeze({
            ...operationNative!,
            ...common,
            outcome: response.outcome,
            status: response.status,
          }),
        }
  );
  if (response.retryAfterSeconds !== undefined) {
    void reply.header('Retry-After', String(response.retryAfterSeconds));
  }
  void reply.type('application/json; charset=utf-8');
  return reply.send(responseBytes);
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  reply.raw.once('close', abort);
  if (request.raw.aborted || request.raw.socket.destroyed || reply.raw.destroyed) abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    request.raw.socket.removeListener('close', abort);
    reply.raw.removeListener('close', abort);
  }
}

async function handle<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  descriptor: RouteDescriptor,
  routeAdmission: HostedRouteAdmission,
  provenance: HostedProducerProvenance,
  createContext: HostedTeamApprovalsContextFactory,
  operation: (context: QueryContext) => Promise<T>,
  prepare: (result: T) => PreparedResponse
): Promise<FastifyReply> {
  void reply.header('Cache-Control', 'no-store');
  const requestBytes = rawRequestBodies.get(request);
  if (requestBytes === undefined) {
    throw new TypeError('hosted-team-approval-request-bytes-missing');
  }
  let boundOperation: ProductHostedProducerOperation | null = null;
  try {
    return await withRequestSignal(request, reply, async (signal) => {
      const invocation = await routeAdmission.invoke(descriptor.id, async () => {
        const context = await createContext(descriptor, request, signal);
        if (signal.aborted || context.signal !== signal) return null;
        const provenanceOperation = bindProductHostedProducerOperation(
          context,
          provenance,
          randomBytes(32).toString('hex')
        );
        boundOperation = provenanceOperation;
        return Object.freeze({ value: await operation(context), operation: provenanceOperation });
      });
      return invocation.admitted && invocation.value !== null
        ? dispatchPreparedResponse(
            reply,
            descriptor,
            requestBytes,
            invocation.value.operation,
            provenance,
            prepare(invocation.value.value)
          )
        : dispatchPreparedResponse(
            reply,
            descriptor,
            requestBytes,
            null,
            provenance,
            unavailableResponse()
          );
    });
  } catch (error) {
    if (isHostedProducerProvenanceFatalError(error)) {
      request.raw.destroy(error);
      reply.raw.destroy(error);
      throw error;
    }
    if (boundOperation !== null) {
      return dispatchPreparedResponse(
        reply,
        descriptor,
        requestBytes,
        boundOperation,
        provenance,
        unavailableResponse()
      );
    }
    throw error;
  }
}

export function registerHostedTeamApprovalsHttp(
  app: FastifyInstance,
  contribution: HostedRouteContribution<HostedTeamApprovalsHttpFacade>,
  routeAdmission: HostedRouteAdmission,
  provenance: HostedProducerProvenance,
  createContext: HostedTeamApprovalsContextFactory
): void {
  if (contribution.id !== 'team-approvals.hosted.v1') {
    throw new TypeError('hosted-team-approvals-route-contribution-invalid');
  }
  if (
    contribution.routes.length !== HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS.length ||
    contribution.routes.some(
      (descriptor, index) => descriptor !== HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[index]
    )
  ) {
    throw new TypeError('hosted-team-approvals-route-contribution-invalid');
  }
  const descriptors = HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS;
  const facade = contribution.facade;
  const routeOptions = Object.freeze({
    bodyLimit: HOSTED_TEAM_APPROVAL_REQUEST_BODY_LIMIT_BYTES,
    preParsing: captureExactRequestBody,
  });
  app.post<{ Body: unknown }>(descriptors[0].path, routeOptions, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[0],
      routeAdmission,
      provenance,
      createContext,
      (context) => facade.getPage(request.body, context),
      preparePageResult
    )
  );
  app.post<{ Body: unknown }>(descriptors[1].path, routeOptions, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[1],
      routeAdmission,
      provenance,
      createContext,
      (context) => facade.getPreview(request.body, context),
      preparePreviewResult
    )
  );
  app.post<{ Body: unknown }>(descriptors[2].path, routeOptions, (request, reply) =>
    handle(
      request,
      reply,
      descriptors[2],
      routeAdmission,
      provenance,
      createContext,
      (context) => facade.decide(request.body, context),
      prepareDecisionResult
    )
  );
}
