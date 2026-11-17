import { redactDiagnosticAssignments } from '../../diagnostics/redactDiagnosticAssignments.js';
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
  endpoint?: Pick<MemberProviderContext['endpoint'], 'bearerToken'> & Partial<Pick<MemberProviderContext['endpoint'], 'url'>>;
  profile: Pick<MemberProviderContext['profile'], 'environment' | 'capturedMcpServers'>;
};

function redactSyntax(value: string): string {
  // The raw line is already bounded. Classify before exact masking can alter a key or URL,
  // and do not truncate a held value before its complete sanitized form is masked.
  return sanitizeRuntimeDiagnosticText(redactDiagnosticAssignments(value, privateName), Number.MAX_SAFE_INTEGER) ?? '';
}

function privateValues(context: StderrContext, args: readonly string[]): string[] {
  const values = context.endpoint
    ? [context.endpoint.bearerToken, ...(context.endpoint.url ? [context.endpoint.url] : [])] : [];
  const assignments = (source: Readonly<Record<string, string>> | undefined): void => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (privateName(key)) values.push(value);
    }
  };
  const argumentsOf = (args: readonly string[] | undefined): void => {
    for (let index = 0; index < (args?.length ?? 0); index++) {
      const arg = args![index]!;
      const match = /^(?:--)?([^=:\s]+)(?:[=:](.*))?$/s.exec(arg);
      if (!match || !privateName(match[1]!)) continue;
      const value = match[2] ?? args![index + 1];
      if (value !== undefined) {
        values.push(value);
        try { const decoded: unknown = JSON.parse(value); if (typeof decoded === 'string') values.push(decoded); }
        catch { /* Literal argv values are still removed exactly. */ }
      }
    }
  };
  assignments(context.profile.environment);
  argumentsOf(args);
  for (const server of Object.values(context.profile.capturedMcpServers ?? {})) {
    if (server.type === 'stdio') { assignments(server.env); argumentsOf(server.args); }
    else for (const value of Object.values(server.headers ?? {})) {
      values.push(value, value.replace(/^(?:Bearer|Basic)\s+/i, ''));
    }
  }
  const forms = new Set<string>();
  for (const value of values) {
    const text = normalize(value);
    const lines = text.split(/\r?\n/);
    for (const component of [text, ...lines, ...lines.map(line => line.replace(/\s+/g, ' ').trim())]) {
      if (!component) continue;
      forms.add(component);
      forms.add(JSON.stringify(component).slice(1, -1));
      try { forms.add(encodeURIComponent(component)); } catch { /* Malformed Unicode has no URI form. */ }
    }
  }
  for (const value of [...forms]) {
    const redacted = redactSyntax(value);
    if (redacted) forms.add(redacted);
  }
  // A whole existing marker wins over any overlapping short private value inside it.
  forms.add('[redacted]');
  return [...forms].sort((a, b) => b.length - a.length);
}

function redactPrivateValues(text: string, secrets: readonly string[]): string {
  const hidden = new Uint8Array(text.length);
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1))
      hidden.fill(1, at, at + secret.length);
  }
  let result = '', start = 0;
  while (start < text.length) {
    const masked = hidden[start] === 1;
    let end = start + 1;
    while (end < text.length && (hidden[end] === 1) === masked) end++;
    result += masked ? '[redacted]' : text.slice(start, end);
    start = end;
  }
  return result;
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
  let secrets: string[], normalizedSecrets: string[];
  try {
    secrets = privateValues(context, args);
    normalizedSecrets = secrets.map(secret => secret.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  catch { emit({ kind: 'gap', reason: 'oversized' }); return; }
  let pending = Buffer.alloc(0), oversized = false, suppressed = false, finished = false, scanTail = '';
  const line = (bytes: Buffer) => {
    const value = normalize(bytes.toString('utf8'));
    const boundary = runtimeDiagnosticDumpBoundary(value);
    if (suppressed) { if (boundary === 'end') suppressed = false; return; }
    if (boundary === 'start') {
      suppressed = true;
      emit({ kind: 'process-output', stream: 'stderr', text: RUNTIME_DIAGNOSTIC_DUMP_HIDDEN });
      return;
    }
    const text = redactPrivateValues(redactSyntax(value), secrets);
    if (text) emit(Buffer.byteLength(text) > MAX_LINE_BYTES
      ? { kind: 'gap', reason: 'oversized' }
      : { kind: 'process-output', stream: 'stderr',
        text: text === redactSyntax(redactPrivateValues(value.replace(/\s+/g, ' ').trim(), normalizedSecrets))
          ? text : '[redacted]' });
  };
  const complete = () => {
    const bytes = pending, dropped = oversized;
    pending = Buffer.alloc(0); oversized = false; scanTail = '';
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
        const scanned = normalize(scanTail + bytes.subarray(offset, end).toString('utf8')).replace(/\s+/g, ' ');
        const discardedDump = runtimeDiagnosticDumpBoundary(scanned) === 'start';
        scanTail = scanned.slice(-512);
        if (oversized && (discardedDump || scanned.includes('\u001b'))) suppressed = true;
        if (!oversized) {
          const available = MAX_LINE_BYTES - pending.length;
          pending = Buffer.concat([pending, bytes.subarray(offset, Math.min(end, offset + available))]);
          if (end - offset > available) {
            const prefix = normalize(pending.toString('utf8'));
            // An unfinished escape can hide a dump opener whose prefix is about to be lost.
            suppressed ||= discardedDump || prefix.includes('\u001b') || runtimeDiagnosticDumpBoundary(prefix) === 'start';
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
