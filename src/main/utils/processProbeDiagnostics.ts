import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';
import { redactSentryEvent } from '@shared/utils/sentryConfig';

/** Only copy outcome metadata: exec errors can embed commands and stdout in their message. */
export function processProbeDiagnostic(
  operation: string,
  startedAt: number,
  timeoutMs: number,
  reason: string,
  error?: unknown,
  stderr?: string
): string {
  const outcome = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const fields = [
    `${operation}: ${reason}`,
    `durationMs=${Math.max(0, Math.round(performance.now() - startedAt))}`,
    `timeoutMs=${timeoutMs}`,
  ];
  for (const key of ['code', 'errno', 'signal', 'killed'] as const) {
    const value = outcome[key];
    if (
      (typeof value === 'number' && Number.isFinite(value)) ||
      (key === 'killed' && typeof value === 'boolean') ||
      ((key === 'code' || key === 'signal') &&
        typeof value === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(value))
    ) {
      fields.push(`${key}=${value}`);
    }
  }
  // Node's killed/signal fields do not establish why a child was terminated.
  fields.push(`timedOut=${outcome.code === 'ETIMEDOUT' ? 'true' : 'unknown'}`);
  const preview = boundedDiagnosticString(String(redactSentryEvent(stderr ?? '')));
  fields.push(`stderr=${JSON.stringify(preview ?? '')}`);
  return fields.join('; ');
}

export type ProcessProbeObserver = (diagnostic: string) => void | Promise<void>;

export function observeProcessProbe(
  observer: ProcessProbeObserver | undefined,
  diagnostic: string
): void {
  try {
    void Promise.resolve(observer?.(diagnostic)).catch(() => undefined);
  } catch {
    // Observation must never change the probe's result.
  }
}
