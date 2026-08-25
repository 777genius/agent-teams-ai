import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';

import { HOSTED_READINESS_ROUTE, parseHostedReadinessProjection } from '../../contracts';
import { compareHostedReadinessFreshness } from '../../core/domain/HostedReadinessProjectionPolicy';
import {
  type CreateHostedReadinessTransportDependencies,
  type HostedReadinessRendererTransport,
  HostedReadinessTransportError,
} from '../ports/HostedReadinessRendererPorts';

export const HOSTED_READINESS_TRANSPORT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const HEADERS = Object.freeze({ Accept: 'application/json' as const });

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? HOSTED_READINESS_TRANSPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new TypeError('hosted-readiness-transport-timeout-invalid');
  }
  return timeout;
}

/** Browser-only authenticated transport with an immutable deployment/boot fence. */
export function createHostedReadinessTransport(
  dependencies: CreateHostedReadinessTransportDependencies
): HostedReadinessRendererTransport {
  if (!dependencies || typeof dependencies.fetch !== 'function') {
    throw new TypeError('hosted-readiness-transport-dependencies-invalid');
  }
  const expectedDeploymentId = parseDeploymentId(dependencies.expectedDeploymentId);
  const expectedBootId = parseBootId(dependencies.expectedBootId);
  const timeoutMs = validateTimeout(dependencies.timeoutMs);
  let lastProjection: Awaited<ReturnType<HostedReadinessRendererTransport['load']>> | undefined;

  return Object.freeze({
    async load(signal?: AbortSignal) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new HostedReadinessTransportError('transport_unavailable');
      }
      if (signal?.aborted) throw new HostedReadinessTransportError('request_cancelled');

      const controller = new AbortController();
      let cancellationCode: 'request_cancelled' | 'deadline_exceeded' = 'deadline_exceeded';
      let rejectCancellation: ((error: HostedReadinessTransportError) => void) | undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const cancel = (code: 'request_cancelled' | 'deadline_exceeded'): void => {
        if (controller.signal.aborted) return;
        cancellationCode = code;
        controller.abort();
        rejectCancellation?.(new HostedReadinessTransportError(code));
      };
      const abortFromCaller = (): void => cancel('request_cancelled');
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      const timer = setTimeout(() => cancel('deadline_exceeded'), timeoutMs);

      try {
        const operation = Promise.resolve().then(async () => {
          const response = await dependencies.fetch(HOSTED_READINESS_ROUTE, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: HEADERS,
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            throw new HostedReadinessTransportError(cancellationCode);
          }
          if (!response || response.status !== 200 || typeof response.json !== 'function') {
            throw new HostedReadinessTransportError('transport_unavailable');
          }
          const parsed = parseHostedReadinessProjection(await response.json());
          if (controller.signal.aborted) {
            throw new HostedReadinessTransportError(cancellationCode);
          }
          if (!parsed.ok) throw new HostedReadinessTransportError('response_invalid');
          if (parsed.value.deploymentId !== expectedDeploymentId) {
            throw new HostedReadinessTransportError('stale_deployment');
          }
          if (parsed.value.bootId !== expectedBootId) {
            throw new HostedReadinessTransportError('stale_boot');
          }
          const freshness = compareHostedReadinessFreshness(lastProjection, parsed.value);
          if (freshness !== 'accept') {
            throw new HostedReadinessTransportError(freshness);
          }
          lastProjection = parsed.value;
          return parsed.value;
        });
        return await Promise.race([operation, cancellation]);
      } catch (error) {
        if (error instanceof HostedReadinessTransportError) throw error;
        throw new HostedReadinessTransportError('transport_unavailable');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
        if (!controller.signal.aborted) controller.abort();
      }
    },
  });
}
