import { redactDiagnosticAssignments } from '../../../dist/diagnostics/redactDiagnosticAssignments.js';
import { sanitizeRuntimeDiagnosticText } from '../../../dist/diagnostics/runtimeDiagnosticText.js';

import type { RuntimeActivityRecord } from '../../../dist/runtime/activityContracts.js';

const TRANSPORT_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
] as const;

/** Goal TEST only: copy existing transport settings, including intentional empty values. */
export function goalTransportEnvironment(source: Readonly<Record<string, string | undefined>>) {
  const selected: Record<string, string> = {};
  for (const key of TRANSPORT_KEYS) {
    const value = source[key];
    if (Object.hasOwn(source, key) && typeof value === 'string') selected[key] = value;
  }
  return selected;
}

export const GOAL_DIAGNOSTIC_LIMITS = Object.freeze({
  sourceEvents: 256, events: 32, sourceTextBytes: 32 * 1024, text: 1024, bytes: 16 * 1024,
});
const privateKey = (key: string) => /api[_-]?key|auth|token|secret|password|credential|cookie|private[_-]?key/i.test(key);

/** Read after original Host cleanup under its existing Runtime fence; never a native request. */
export function goalRuntimeDiagnostics(
  record: Pick<RuntimeActivityRecord, 'sequence' | 'events'> | undefined,
  heldPrivateValues: readonly string[] = [],
) {
  if (!record) return { status: 'absent' as const, truncated: false, events: [] };
  const limits = GOAL_DIAGNOSTIC_LIMITS;
  let truncated = record.events.length > limits.sourceEvents || (record.events[0]?.sequence ?? 1) > 1;
  const text = (value: unknown, limit: number = limits.text): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (Buffer.byteLength(value) > limits.sourceTextBytes) {
      truncated = true;
      return '[oversized diagnostic omitted]';
    }
    // Native stderr was already sanitized by its owner. Mask held transport values
    // and use the existing assignment parser again before clipping the public receipt.
    let selected = value;
    for (const secret of heldPrivateValues) if (secret) selected = selected.replaceAll(secret, '[redacted]');
    const safe = sanitizeRuntimeDiagnosticText(redactDiagnosticAssignments(selected, privateKey), limits.sourceTextBytes);
    if (safe && safe.length > limit) truncated = true;
    return sanitizeRuntimeDiagnosticText(safe, limit);
  };
  const events: Record<string, unknown>[] = [];
  let bytes = 512; // Reserve the small receipt envelope as well as event separators.
  for (let index = record.events.length - 1; index >= Math.max(0, record.events.length - limits.sourceEvents); index--) {
    const event = record.events[index]!, source = event.data;
    let data: Record<string, unknown>;
    if (source.kind === 'process-output' && source.stream === 'stderr')
      data = { kind: source.kind, stream: 'stderr', text: text(source.text) };
    else if (source.kind === 'diagnostic') data = { kind: source.kind, code: text(source.code, 128) };
    else if (source.kind === 'result') data = { kind: source.kind, code: text(source.code, 128),
      outcome: typeof source.outcome === 'string' && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(source.outcome)
        ? source.outcome : undefined };
    else if (source.kind === 'gap') data = { kind: source.kind, reason: text(source.reason, 128) };
    else continue; // Never copy model text, tool arguments, interactions or arbitrary configuration.
    const selected = { sequence: event.sequence, observedAt: text(event.observedAt, 128),
      inputId: text(event.inputId, 128), operationRef: text(event.operationRef, 128), data };
    const size = Buffer.byteLength(JSON.stringify(selected)) + 1;
    if (events.length === limits.events || bytes + size > limits.bytes) { truncated = true; break; }
    events.unshift(selected);
    bytes += size;
  }
  return { status: 'available' as const, sequence: record.sequence,
    retainedFrom: record.events[0]?.sequence, truncated, events };
}
