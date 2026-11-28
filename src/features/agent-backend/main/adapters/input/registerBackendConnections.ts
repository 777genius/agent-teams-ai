import { createLogger } from '@shared/utils/logger';

import {
  AGENT_BACKEND_CONNECTIONS_CHANNEL,
  AGENT_BACKEND_CONNECTIONS_ROUTE,
} from '../../../contracts/connections';

import type { BackendConnectionSnapshot } from '../../../contracts/connections';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { DesktopBackendFeature } from '../../composition/DesktopBackendFeature';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const denied = (): BackendConnectionSnapshot => ({ state: 'hold', bindings: [] });

type DiscoveryPhase =
  | 'capture-context'
  | 'guard-before-initialize'
  | 'initialize'
  | 'context-after-initialize'
  | 'guard-after-initialize'
  | 'discover-bindings';
const failureCodes = new Set([
  'invalid-binding',
  'binding-conflict',
  'unavailable',
  'hold',
  'shutting-down',
  'forbidden',
  'invalid-profile',
  'profile-mismatch',
  'protocol-error',
  'transport-closed',
  'request-timeout',
  'capacity-exceeded',
  'remote-error',
  'remote-rejected',
]);
const reported = new Set<string>();
function failureCode(error: unknown): string {
  if (error instanceof ReferenceError) return 'reference-error';
  if (error instanceof TypeError) return 'type-error';
  try {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    return typeof code === 'string' && failureCodes.has(code) ? code : 'unexpected';
  } catch {
    return 'unexpected';
  }
}
function reportHeld(phase: DiscoveryPhase, code: string): void {
  const key = phase + ':' + code;
  if (reported.has(key)) return;
  reported.add(key);
  try {
    createLogger('Feature:AgentBackendConnections').warn('Captured backend discovery held', {
      phase,
      code,
    });
  } catch {
    /* Diagnostics cannot change fail-closed discovery. */
  }
}

async function snapshot<Context>(
  feature: DesktopBackendFeature,
  context: Context,
  captureContext: (context: Context) => string | null,
  guard?: BackendRequestGuard
): Promise<BackendConnectionSnapshot> {
  let phase: DiscoveryPhase = 'capture-context';
  try {
    const before = captureContext(context);
    if (!before) {
      reportHeld(phase, 'missing-context');
      return denied();
    }
    phase = 'guard-before-initialize';
    if (guard && !guard.isCurrent()) {
      reportHeld(phase, 'forbidden');
      return denied();
    }
    phase = 'initialize';
    await feature.initialize();
    // Navigation or a context switch during initialization invalidates the old request.
    phase = 'context-after-initialize';
    if (captureContext(context) !== before) {
      reportHeld(phase, 'context-changed');
      return denied();
    }
    phase = 'guard-after-initialize';
    if (guard && !guard.isCurrent()) {
      reportHeld(phase, 'forbidden');
      return denied();
    }
    phase = 'discover-bindings';
    const result = await feature.discoverBindings(before, {
      isCurrent: () => captureContext(context) === before && (!guard || guard.isCurrent()),
    });
    if (result.state === 'hold') reportHeld(phase, 'hold');
    return result;
  } catch (error) {
    reportHeld(phase, failureCode(error));
    return denied();
  }
}

export function registerBackendConnectionsIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  feature: DesktopBackendFeature,
  captureContext: (event: IpcMainInvokeEvent) => string | null,
  captureGuard?: (event: IpcMainInvokeEvent) => BackendRequestGuard
): () => void {
  ipc.handle(AGENT_BACKEND_CONNECTIONS_CHANNEL, (event, ...args: unknown[]) =>
    args.length ? denied() : snapshot(feature, event, captureContext, captureGuard?.(event))
  );
  return () => ipc.removeHandler(AGENT_BACKEND_CONNECTIONS_CHANNEL);
}

export function registerBackendConnectionsHttp(
  app: FastifyInstance,
  feature: DesktopBackendFeature,
  captureContext: (request: FastifyRequest) => string | null
): void {
  app.get(AGENT_BACKEND_CONNECTIONS_ROUTE, (request) =>
    Object.keys(request.query ?? {}).length ? denied() : snapshot(feature, request, captureContext)
  );
}
