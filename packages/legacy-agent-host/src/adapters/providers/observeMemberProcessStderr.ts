import {
  RUNTIME_DIAGNOSTIC_DUMP_HIDDEN, runtimeDiagnosticDumpBoundary,
  sanitizeRuntimeDiagnosticText, stripRuntimeDiagnosticAnsi,
} from '../../diagnostics/runtimeDiagnosticText.js';
import type { ObservableNativeProcess } from '../../owned-process/processFacade.js';
import type { RuntimeProcessOutput } from '../../runtime/providerActivityContracts.js';
import type { MemberProviderContext } from './MemberProvider.js';

const MAX_LINE_BYTES = 24 * 1024;
// Select already-held private values, including flags beyond the legacy inline assignment syntax.
const privateName = (name: string) => /api[_-]?key|auth|token|secret|password|credential|cookie|private[_-]?key/i.test(name);
const normalize = (value: string) => stripRuntimeDiagnosticAnsi(value).replace(/\0/g, '\uFFFD');
type StderrContext = Pick<MemberProviderContext, 'observeProcessOutput'> & {
  endpoint: Pick<MemberProviderContext['endpoint'], 'bearerToken'>;
  profile: Pick<MemberProviderContext['profile'], 'environment' | 'capturedMcpServers'>;
};

/** Only values already present in this selected launch; no environment or credential discovery. */
function privatePattern(context: StderrContext, args: readonly string[]): RegExp | undefined {
  const values = [context.endpoint.bearerToken];
  const environment = (entries: Record<string, string> = {}) => {
    for (const [key, value] of Object.entries(entries)) if (privateName(key)) values.push(value);
  };
  const argumentsOf = (selected: readonly string[]) => {
    for (let index = 0; index < selected.length; index++) {
      const argument = selected[index]!;
      const separator = argument.indexOf('=');
      const name = separator < 0 ? argument : argument.slice(0, separator);
      if (!privateName(name)) continue;
      const value = separator < 0 ? selected[index + 1] : argument.slice(separator + 1);
      if (!value) continue;
      values.push(value);
      try { const decoded: unknown = JSON.parse(value); if (typeof decoded === 'string') values.push(decoded); }
      catch { /* Native arguments may be plain strings rather than JSON settings. */ }
    }
  };
  environment(context.profile.environment);
  argumentsOf(args);
  for (const server of Object.values(context.profile.capturedMcpServers ?? {})) {
    if (server.type === 'stdio') { environment(server.env); argumentsOf(server.args ?? []); }
    else for (const value of Object.values(server.headers ?? {}))
      values.push(value, value.replace(/^(?:bearer|basic)\s+/i, ''));
  }
  const candidates = new Set(values.flatMap(value => normalize(value).split(/\r?\n/)
    .flatMap(line => [line, line.replace(/\s+/g, ' ').trim(), JSON.stringify(line).slice(1, -1)])));
  const selected = [...candidates].filter(value => value.length > 0 && Buffer.byteLength(value) <= MAX_LINE_BYTES)
    .sort((a, b) => b.length - a.length);
  // One replacement pass prevents short private values from re-matching our replacement marker.
  return selected.length ? new RegExp(selected.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
}

/** Observe the original target stderr; custody and native protocol streams keep their existing owners. */
export function observeMemberProcessStderr(
  child: ObservableNativeProcess, context: StderrContext, args: readonly string[]
): void {
  const observer = context.observeProcessOutput;
  if (!observer) return;
  const emit = (value: RuntimeProcessOutput) => {
    try { observer(value); } catch { /* Observations never replace provider outcomes. */ }
  };
  let secrets: RegExp | undefined;
  try { secrets = privatePattern(context, args); }
  catch { emit({ kind: 'gap', reason: 'oversized' }); return; }
  let pending = Buffer.alloc(0), oversized = false, suppressed = false, finished = false;
  const line = (bytes: Buffer) => {
    const value = normalize(bytes.toString('utf8'));
    const boundary = runtimeDiagnosticDumpBoundary(value);
    if (suppressed) { if (boundary === 'end') suppressed = false; return; }
    if (boundary === 'start') {
      suppressed = true;
      emit({ kind: 'process-output', stream: 'stderr', text: RUNTIME_DIAGNOSTIC_DUMP_HIDDEN });
      return;
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    const text = sanitizeRuntimeDiagnosticText(secrets ? normalized.replace(secrets, '[redacted]') : normalized, MAX_LINE_BYTES);
    if (text) emit(Buffer.byteLength(text) > MAX_LINE_BYTES
      ? { kind: 'gap', reason: 'oversized' }
      : { kind: 'process-output', stream: 'stderr', text });
  };
  const complete = () => {
    const bytes = pending, dropped = oversized;
    pending = Buffer.alloc(0); oversized = false;
    if (dropped) emit({ kind: 'gap', reason: 'oversized' });
    else if (bytes.length) line(bytes);
  };
  const data = (chunk: Buffer | string) => {
    if (finished) return;
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let offset = 0; offset < bytes.length && !finished;) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        if (!oversized) {
          const available = MAX_LINE_BYTES - pending.length;
          pending = Buffer.concat([pending, bytes.subarray(offset, Math.min(end, offset + available))]);
          if (end - offset > available) {
            suppressed ||= runtimeDiagnosticDumpBoundary(normalize(pending.toString('utf8'))) === 'start';
            pending = Buffer.alloc(0); oversized = true;
          }
        }
        if (newline < 0) break;
        complete(); offset = newline + 1;
      }
    } catch {
      pending = Buffer.alloc(0); oversized = true; // Discard through the next complete line boundary.
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    try { complete(); } catch { /* The original process owns failures and cleanup. */ }
    child.stderr.removeListener('data', data);
    child.stderr.removeListener('end', finish);
    child.stderr.removeListener('close', finish);
    child.removeListener('close', finish);
  };
  child.stderr.on('data', data);
  child.stderr.once('end', finish);
  child.stderr.once('close', finish);
  child.once('close', finish);
}
