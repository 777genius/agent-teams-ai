import { type Socket } from 'node:net';

import { type QueryContext, type TeamId, type WorkspaceId } from '@shared/contracts/hosted';

import { type HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import {
  serializeOrchestratorLifecycleAuthority,
  serializeOrchestratorLifecycleContext,
} from '../../../application/ExecuteHostedLifecycleCommand';

const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const EXCHANGE_ID_PATTERN = /^lifecycle-request_[0-9a-f]{32}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

interface OrchestratorLifecycleResponseFrameListenerOptions {
  readonly isSettled: () => boolean;
  readonly acceptResponse: (serializedEnvelope: string) => Promise<void>;
  readonly finish: (error: Error) => void;
}

export function requireOrchestratorLifecycleRequestSize(body: string): void {
  if (Buffer.byteLength(body) > MAXIMUM_MESSAGE_BYTES) {
    throw new Error('orchestrator-lifecycle-request-too-large');
  }
}

export function parseOrchestratorLifecycleTimeout(timeoutMs = DEFAULT_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('orchestrator-lifecycle-timeout-invalid');
  }
  return timeoutMs;
}

export function createOrchestratorLifecycleExchangeId(generateExchangeId: () => string): string {
  try {
    const exchangeId = generateExchangeId();
    if (!EXCHANGE_ID_PATTERN.test(exchangeId)) throw new TypeError();
    return exchangeId;
  } catch {
    throw new Error('orchestrator-lifecycle-request-identity-invalid');
  }
}

export function createOrchestratorLifecycleQueryPayload<
  Request extends { readonly workspaceId: WorkspaceId; readonly teamId: TeamId },
>(
  request: Request,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    request,
    context: serializeOrchestratorLifecycleContext(context),
    authority: serializeOrchestratorLifecycleAuthority(
      context,
      request.workspaceId,
      request.teamId,
      restoreGeneration,
      mountGeneration,
      null,
      ownerEffectFence
    ),
  });
}

export function listenForOrchestratorLifecycleResponseFrame(
  socket: Socket,
  options: OrchestratorLifecycleResponseFrameListenerOptions
): void {
  let response = '';
  let responseBytes = 0;
  let validatingResponse = false;
  let readableEnded = false;

  socket.on('data', (chunk: string) => {
    if (options.isSettled() || validatingResponse) return;
    responseBytes += Buffer.byteLength(chunk);
    if (responseBytes > MAXIMUM_MESSAGE_BYTES) {
      options.finish(new Error('orchestrator-lifecycle-response-too-large'));
      return;
    }
    response += chunk;
    const newline = response.indexOf('\n');
    if (newline < 0) return;
    if (newline !== response.length - 1) {
      options.finish(new Error('orchestrator-lifecycle-response-invalid'));
    }
  });
  socket.once('end', () => {
    readableEnded = true;
    if (options.isSettled() || validatingResponse) return;
    if (response.indexOf('\n') !== response.length - 1) {
      options.finish(new Error('orchestrator-lifecycle-response-incomplete'));
      return;
    }
    validatingResponse = true;
    void options.acceptResponse(response);
  });
  socket.once('close', () => {
    if (options.isSettled() || validatingResponse) return;
    options.finish(
      new Error(
        readableEnded
          ? 'orchestrator-lifecycle-response-invalid'
          : 'orchestrator-lifecycle-response-incomplete'
      )
    );
  });
}
