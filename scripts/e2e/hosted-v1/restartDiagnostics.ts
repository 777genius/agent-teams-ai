import { execFile } from 'node:child_process';
import { type ClientRequest, type IncomingMessage, request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';

import { restartHostedV1LifecycleOwner } from './run';

const STAGE_DEADLINE_MS = 60_000;
const STAGE_EXECUTION_CAP_BYTES = 8 * 1024 * 1024;
const RETAINED_OUTPUT_CAP_BYTES = 32 * 1024;
const DIAGNOSTIC_DEADLINE_MS = 1_500;
const DIAGNOSTIC_OUTPUT_CAP_BYTES = 64 * 1024;
const READINESS_DEADLINE_MS = 1_000;
const READINESS_OBSERVATION_LIMIT = 16;
const READINESS_INTERVAL_MS = 250;
const READINESS_HEADER = 'x-agent-teams-lifecycle-owner-readiness';

export type RestartFailureClassification =
  | 'nonzero_exit'
  | 'timeout_associated_termination'
  | 'external_signal'
  | 'missing_metadata';

export interface CommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | string | null;
  readonly signal?: NodeJS.Signals | string | null;
  readonly killed?: boolean;
}

export type RunCommand = (
  executable: string,
  args: readonly string[],
  options: { readonly deadlineMs: number; readonly outputCapBytes: number }
) => Promise<CommandResult>;

interface CommandObservation {
  readonly args: readonly string[];
  readonly configuredDeadlineMs: number;
  readonly configuredOutputCapBytes: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly killed: boolean | null;
  readonly error: string | null;
  readonly classification: RestartFailureClassification | null;
}

export interface RestartDiagnosticReport {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stages: readonly (CommandObservation & { readonly stage: string })[];
  readonly containerState: readonly ContainerStateObservation[];
  readonly readiness: readonly ReadinessObservation[];
  readonly logTails: readonly LogTailObservation[];
  readonly diagnosticFailures: readonly DiagnosticFailure[];
}

interface DiagnosticFailure {
  readonly operation: string;
  readonly at: string;
  readonly error: string;
}

interface ContainerStateObservation {
  readonly phase: 'before_restart' | 'failure_before_teardown';
  readonly at: string;
  readonly services: readonly unknown[];
  readonly inspect: readonly unknown[];
}

interface ReadinessObservation {
  readonly at: string;
  readonly configuredDeadlineMs: number;
  readonly latencyMs: number;
  readonly status: number | null;
  readonly readinessHeader: string | null;
  readonly transportError: string | null;
}

interface LogTailObservation {
  readonly phase: 'before_restart' | 'failure_before_teardown';
  readonly service: 'hosted-controller' | 'fake-runtime';
  readonly at: string;
  readonly configuredDeadlineMs: number;
  readonly configuredOutputCapBytes: number;
  readonly output: string;
  readonly error: string | null;
}

export interface RestartDiagnosticsInput {
  readonly composeArgs: readonly string[];
  readonly origin: string;
  readonly runCommand?: RunCommand;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly toIso?: (milliseconds: number) => string;
  readonly diagnosticLimits?: {
    readonly commandDeadlineMs?: number;
    readonly commandOutputCapBytes?: number;
    readonly readinessDeadlineMs?: number;
    readonly readinessIntervalMs?: number;
    readonly readinessObservationLimit?: number;
    readonly retainedOutputCapBytes?: number;
  };
  readonly emit: (report: RestartDiagnosticReport) => void | Promise<void>;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|set-cookie|password|passwd|token|secret|credential|api[_-]?key|pairing|csrf|trust|admission|environment|\benv\b|request[_-]?body|response[_-]?body|\bbody\b)/iu;
const SENSITIVE_TAIL_MARKER =
  /(?:authorization|cookie|set-cookie|password|passwd|token|secret|credential|api[_-]?key|pairing|csrf|trust|admission|environment|\benv\b|request[_-]?body|response[_-]?body|\bbody\b)(?=(?:\s|\\+["']|["'])*[:=])/iu;
const SENSITIVE_KEY_SUFFIX =
  /(?:authorization|cookie|set-cookie|password|passwd|token|secret|credential|api[_-]?key|pairing|csrf|trust|admission|environment|\benv\b|request[_-]?body|response[_-]?body|\bbody\b)$/iu;

function hasSensitiveMarkerPrefix(value: string): boolean {
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1]!;
    if (/\s/u.test(character)) {
      end -= 1;
      continue;
    }
    if (character === '"' || character === "'") {
      end -= 1;
      while (value[end - 1] === '\\') end -= 1;
      continue;
    }
    break;
  }
  return SENSITIVE_KEY_SUFFIX.test(value.slice(Math.max(0, end - 32), end));
}

function capUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  const suffix = `\n[truncated:${bytes.length}-byte-input]`;
  const suffixBytes = Buffer.from(suffix, 'utf8');
  if (suffixBytes.length >= maximumBytes) {
    return suffixBytes.subarray(0, maximumBytes).toString('utf8');
  }
  let prefix = bytes.subarray(0, maximumBytes - suffixBytes.length).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') + suffixBytes.length > maximumBytes) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}

function opaqueText(value: string, maximumBytes: number): string {
  if (value === '') return '';
  return capUtf8(`[REDACTED_TEXT:${Buffer.byteLength(value, 'utf8')}-bytes]`, maximumBytes);
}

type BracedUnicodeEscape =
  | { readonly kind: 'not_braced' }
  | { readonly kind: 'invalid'; readonly length: number }
  | { readonly kind: 'valid'; readonly codePoint: number; readonly length: number };

function hexDigit(character: string | undefined): number {
  if (character === undefined) return -1;
  if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
  const lower = character.toLowerCase();
  return lower >= 'a' && lower <= 'f' ? lower.charCodeAt(0) - 87 : -1;
}

function bracedUnicodeEscape(value: string, start: number): BracedUnicodeEscape {
  if (value[start]?.toLowerCase() !== 'u' || value[start + 1] !== '{') {
    return { kind: 'not_braced' };
  }
  let codePoint = 0;
  let digits = 0;
  let validCodePoint = true;
  let validDigits = true;
  for (let index = start + 2; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '}') {
      return digits > 0 && validDigits && validCodePoint
        ? { kind: 'valid', codePoint, length: index - start + 1 }
        : { kind: 'invalid', length: index - start + 1 };
    }
    const digit = hexDigit(character);
    digits += 1;
    if (digit < 0) validDigits = false;
    if (validCodePoint && digit >= 0) {
      codePoint = (codePoint * 16) + digit;
      if (codePoint > 0x10ffff) validCodePoint = false;
    }
  }
  return { kind: 'invalid', length: value.length - start };
}

function markerScanText(value: string): {
  readonly complete: boolean;
  readonly text: string;
  readonly sourceOffsets: readonly number[];
} {
  let scan = {
    text: value,
    sourceOffsets: Array.from({ length: value.length }, (_unused, index) => index),
  };
  // A fixed pass bound permits nested serialized escapes while keeping work linear in input size.
  for (let pass = 0; pass < 8; pass += 1) {
    let text = '';
    const sourceOffsets: number[] = [];
    let decodedEscape = false;
    const append = (character: string, sourceOffset: number): void => {
      const codePoint = character.codePointAt(0);
      text += codePoint !== undefined && (
        codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || codePoint === 0x2028
        || codePoint === 0x2029
      ) ? ' ' : character;
      sourceOffsets.push(...Array.from({ length: character.length }, () => sourceOffset));
    };
    for (let index = 0; index < scan.text.length;) {
      if (scan.text[index] === '\\') {
        let escapeEnd = index;
        while (scan.text[escapeEnd] === '\\') escapeEnd += 1;
        const bracedUnicode = bracedUnicodeEscape(scan.text, escapeEnd);
        const fixedDigits = scan.text[escapeEnd]?.toLowerCase() === 'u' ? 4
          : scan.text[escapeEnd]?.toLowerCase() === 'x' ? 2 : 0;
        let fixedCodePoint = 0;
        let fixedEscapeLength: number | undefined;
        let invalidFixedEscape = false;
        if (fixedDigits > 0) {
          let valid = true;
          for (let digitIndex = 0; digitIndex < fixedDigits; digitIndex += 1) {
            const digit = hexDigit(scan.text[escapeEnd + digitIndex + 1]);
            if (digit < 0) valid = false;
            else fixedCodePoint = (fixedCodePoint * 16) + digit;
          }
          if (valid) fixedEscapeLength = fixedDigits + 1;
          else invalidFixedEscape = true;
        }
        const codePoint = bracedUnicode.kind === 'valid'
          ? bracedUnicode.codePoint
          : fixedEscapeLength === undefined ? undefined : fixedCodePoint;
        const escapeLength = bracedUnicode.kind === 'valid'
          ? bracedUnicode.length
          : fixedEscapeLength;
        if (codePoint !== undefined && escapeLength !== undefined) {
          append(String.fromCodePoint(codePoint), scan.sourceOffsets[index] ?? 0);
          index = escapeEnd + escapeLength;
          decodedEscape = true;
          continue;
        }
        if (bracedUnicode.kind === 'invalid') {
          return { text, sourceOffsets, complete: false };
        }
        if (invalidFixedEscape && hasSensitiveMarkerPrefix(text)) {
          return { text, sourceOffsets, complete: false };
        }
        const escapedControl = scan.text[escapeEnd];
        if (escapedControl !== undefined && /^[bfnrtv0]$/iu.test(escapedControl)) {
          append(' ', scan.sourceOffsets[index] ?? 0);
          index = escapeEnd + 1;
          decodedEscape = true;
          continue;
        }
        for (let slash = index; slash < escapeEnd; slash += 1) {
          append(scan.text[slash]!, scan.sourceOffsets[slash] ?? 0);
        }
        index = escapeEnd;
        continue;
      }
      append(scan.text[index]!, scan.sourceOffsets[index] ?? 0);
      index += 1;
    }
    scan = { text, sourceOffsets };
    if (!decodedEscape) return { ...scan, complete: true };
  }
  return { ...scan, complete: false };
}

function safeDiagnosticText(value: string, maximumBytes: number): string {
  if (value === '') return '';
  const scanned = markerScanText(value);
  if (!scanned.complete) return opaqueText(value, maximumBytes);
  const marker = SENSITIVE_TAIL_MARKER.exec(scanned.text);
  if (marker === null) return opaqueText(value, maximumBytes);
  const sourceOffset = scanned.sourceOffsets[marker.index] ?? 0;
  const prefix = value.slice(0, sourceOffset);
  return capUtf8(`${prefix}[REDACTED_SENSITIVE_TAIL]`, maximumBytes);
}

function safeSelectedString(value: string, maximumBytes: number): string {
  if (/^[A-Za-z0-9_.:/+-]{0,256}$/u.test(value) && !SENSITIVE_KEY.test(value)) {
    return capUtf8(value, maximumBytes);
  }
  return opaqueText(value, maximumBytes);
}

function safeProcessMetadata(value: string, maximumBytes: number): string {
  if (/^(?:EACCES|ENOENT|ETIMEDOUT|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|SIG(?:ABRT|ALRM|BUS|CHLD|CONT|FPE|HUP|ILL|INT|IO|IOT|KILL|PIPE|POLL|PROF|PWR|QUIT|SEGV|STKFLT|STOP|SYS|TERM|TRAP|TSTP|TTIN|TTOU|URG|USR1|USR2|VTALRM|WINCH|XCPU|XFSZ))$/u.test(value)) {
    return capUtf8(value, maximumBytes);
  }
  return opaqueText(value, maximumBytes);
}

function sanitizeArgs(args: readonly string[], maximumBytes: number): readonly string[] {
  return args.map((arg, index) => {
    if (index > 0 && SENSITIVE_KEY.test(args[index - 1] ?? '')) {
      return capUtf8('[REDACTED]', maximumBytes);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) {
      return capUtf8('[REDACTED_ENV]', maximumBytes);
    }
    if (/^(?:compose|stop|restart|up|--[a-z-]+|[0-9]+|hosted-controller|fake-runtime)$/u.test(arg)) {
      return capUtf8(arg, maximumBytes);
    }
    return capUtf8('[REDACTED_ARG]', maximumBytes);
  });
}

function capRetainedStrings(value: unknown, maximumBytes: number): unknown {
  if (typeof value === 'string') return capUtf8(value, maximumBytes);
  if (Array.isArray(value)) {
    return value.map((entry) => capRetainedStrings(entry, maximumBytes));
  }
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, capRetainedStrings(entry, maximumBytes)])
  );
}

function safeError(error: unknown, maximumBytes = RETAINED_OUTPUT_CAP_BYTES): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message === 'restart_diagnostics_readiness_deadline_exceeded'
    ? message
    : safeDiagnosticText(message, maximumBytes);
  return capUtf8(`Error: ${detail}`, maximumBytes);
}

function metadata(error: unknown): CommandResult {
  if (typeof error !== 'object' || error === null) return {};
  const value = error as Record<string, unknown>;
  return {
    stdout: typeof value.stdout === 'string' ? value.stdout : undefined,
    stderr: typeof value.stderr === 'string' ? value.stderr : undefined,
    code:
      typeof value.code === 'number' || typeof value.code === 'string' || value.code === null
        ? value.code
        : undefined,
    signal: typeof value.signal === 'string' || value.signal === null ? value.signal : undefined,
    killed: typeof value.killed === 'boolean' ? value.killed : undefined,
  };
}

export function classifyRestartFailure(value: CommandResult): RestartFailureClassification {
  if (value.killed === true) return 'timeout_associated_termination';
  if (value.signal !== undefined && value.signal !== null) return 'external_signal';
  if (typeof value.code === 'number' && value.code !== 0) return 'nonzero_exit';
  return 'missing_metadata';
}

export const runRestartDiagnosticCommand: RunCommand = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { maxBuffer: options.outputCapBytes, timeout: options.deadlineMs },
      (error, stdout, stderr) => {
        if (error !== null) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: 0, signal: null, killed: false });
      }
    );
  });

function parseDockerJson(output: string): readonly unknown[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
}

function sanitizedData(value: unknown, maximumBytes: number, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizedData(entry, maximumBytes, parentKey));
  if (typeof value !== 'object' || value === null) {
    if (typeof value !== 'string') return value;
    return /^(?:Error|Output)$/u.test(parentKey)
      ? opaqueText(value, maximumBytes)
      : safeSelectedString(value, maximumBytes);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizedData(entry, maximumBytes, key),
    ])
  );
}

function selectFields(value: object, fields: readonly string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of fields) {
    const entry = Reflect.get(value, key);
    if (entry !== undefined) selected[key] = entry;
  }
  return selected;
}

function boundedSetting(value: number | undefined, fallback: number, minimum = 1): number {
  return value === undefined || !Number.isInteger(value)
    ? fallback
    : Math.min(fallback, Math.max(minimum, value));
}

function requestReadiness(
  origin: string,
  deadlineMs: number
): Promise<{ readonly status: number | null; readonly readinessHeader: string | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/auth/status', origin);
    let request: ClientRequest | undefined;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline.timer !== undefined) clearTimeout(deadline.timer);
      operation();
    };
    const observe = (response: IncomingMessage): void => {
      request?.setTimeout(0);
      const header = response.headers[READINESS_HEADER];
      response.destroy();
      finish(() => resolve({
        status: response.statusCode ?? null,
        readinessHeader: Array.isArray(header) ? header.join(',') : header ?? null,
      }));
    };
    const options = { headers: { accept: 'application/json' }, method: 'GET' } as const;
    try {
      request = url.protocol === 'https:'
        ? requestHttps(url, { ...options, rejectUnauthorized: false }, observe)
        : requestHttp(url, options, observe);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    deadline.timer = setTimeout(() => {
      const error = new Error('restart_diagnostics_readiness_deadline_exceeded');
      request?.destroy(error);
      finish(() => reject(error));
    }, deadlineMs);
    request.setTimeout(deadlineMs, () => {
      request.destroy(new Error('restart_diagnostics_readiness_deadline_exceeded'));
    });
    request.once('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

function requestReadinessWithFetch(
  fetchImplementation: typeof globalThis.fetch,
  origin: string,
  deadlineMs: number
): Promise<{ readonly status: number; readonly readinessHeader: string | null }> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline.timer !== undefined) clearTimeout(deadline.timer);
      operation();
    };
    deadline.timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error('restart_diagnostics_readiness_deadline_exceeded')));
    }, deadlineMs);
    let operation: Promise<Response>;
    try {
      operation = fetchImplementation(`${origin}/api/auth/status`, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      controller.abort();
      finish(() => reject(error));
      return;
    }
    void operation.then(
      (response) => {
        const observation = {
          status: response.status,
          readinessHeader: response.headers.get(READINESS_HEADER),
        };
        void response.body?.cancel().catch(() => undefined);
        controller.abort();
        finish(() => resolve(observation));
      },
      (error: unknown) => {
        controller.abort();
        finish(() => reject(error));
      }
    );
  });
}

function selectedComposeState(value: unknown, maximumBytes: number): unknown {
  if (typeof value !== 'object' || value === null) return {};
  const fields = ['ID', 'Id', 'id', 'Service', 'Name', 'State', 'Health', 'ExitCode'] as const;
  return sanitizedData(selectFields(value, fields), maximumBytes);
}

function selectedInspectState(value: unknown, maximumBytes: number): unknown {
  if (typeof value !== 'object' || value === null) return {};
  const state = Reflect.get(value, 'State');
  let selectedState: Record<string, unknown> | null = null;
  if (typeof state === 'object' && state !== null) {
    selectedState = selectFields(state, [
      'Status',
      'Running',
      'Paused',
      'Restarting',
      'OOMKilled',
      'Dead',
      'Pid',
      'ExitCode',
      'Error',
      'StartedAt',
      'FinishedAt',
    ]);
    const health = Reflect.get(state, 'Health');
    if (typeof health === 'object' && health !== null) {
      const selectedHealth = selectFields(health, ['Status', 'FailingStreak']);
      const history = Reflect.get(health, 'Log');
      if (Array.isArray(history)) {
        selectedHealth.Log = history.map((entry) => {
          if (typeof entry !== 'object' || entry === null) return {};
          return selectFields(entry, ['Start', 'End', 'ExitCode', 'Output']);
        });
      }
      selectedState.Health = selectedHealth;
    }
  }
  return sanitizedData({
    Id: Reflect.get(value, 'Id') ?? null,
    RestartCount: Reflect.get(value, 'RestartCount') ?? null,
    State: selectedState,
  }, maximumBytes);
}

export async function restartHostedV1LifecycleOwnerWithDiagnostics(
  input: RestartDiagnosticsInput
): Promise<void> {
  const runCommand = input.runCommand ?? runRestartDiagnosticCommand;
  const now = input.now ?? Date.now;
  const toIso = input.toIso ?? ((milliseconds: number) => new Date(milliseconds).toISOString());
  const diagnosticDeadlineMs = boundedSetting(
    input.diagnosticLimits?.commandDeadlineMs,
    DIAGNOSTIC_DEADLINE_MS
  );
  const diagnosticOutputCapBytes = boundedSetting(
    input.diagnosticLimits?.commandOutputCapBytes,
    DIAGNOSTIC_OUTPUT_CAP_BYTES
  );
  const readinessDeadlineMs = boundedSetting(
    input.diagnosticLimits?.readinessDeadlineMs,
    READINESS_DEADLINE_MS
  );
  const readinessIntervalMs = boundedSetting(
    input.diagnosticLimits?.readinessIntervalMs,
    READINESS_INTERVAL_MS,
    0
  );
  const readinessObservationLimit = boundedSetting(
    input.diagnosticLimits?.readinessObservationLimit,
    READINESS_OBSERVATION_LIMIT
  );
  const retainedOutputCapBytes = boundedSetting(
    input.diagnosticLimits?.retainedOutputCapBytes,
    RETAINED_OUTPUT_CAP_BYTES
  );
  const startedAt = toIso(now());
  const stages: (CommandObservation & { stage: string })[] = [];
  const containerState: ContainerStateObservation[] = [];
  const readiness: ReadinessObservation[] = [];
  const logTails: LogTailObservation[] = [];
  const diagnosticFailures: DiagnosticFailure[] = [];
  const stageNames = ['stop_controller', 'restart_owner', 'wait_owner', 'start_controller'] as const;
  const samplerStop = new AbortController();

  const recordDiagnosticFailure = (operation: string, error: unknown): void => {
    diagnosticFailures.push({
      operation,
      at: toIso(now()),
      error: safeError(error, retainedOutputCapBytes),
    });
  };

  const runDiagnostic = async (operation: string, collect: () => Promise<void>): Promise<void> => {
    try {
      await collect();
    } catch (error) {
      recordDiagnosticFailure(operation, error);
    }
  };

  const collectState = async (
    phase: ContainerStateObservation['phase']
  ): Promise<void> => {
    let services: readonly unknown[] = [];
    try {
      const ps = await runCommand(
        'docker',
        [...input.composeArgs, 'ps', '--all', '--format', 'json', 'hosted-controller', 'fake-runtime'],
        { deadlineMs: diagnosticDeadlineMs, outputCapBytes: diagnosticOutputCapBytes }
      );
      const parsedServices = parseDockerJson(ps.stdout ?? '');
      services = parsedServices.map((entry) =>
        selectedComposeState(entry, retainedOutputCapBytes)
      );
      const ids = parsedServices.flatMap((service) => {
        if (typeof service !== 'object' || service === null) return [];
        const id = Reflect.get(service, 'ID') ?? Reflect.get(service, 'Id') ?? Reflect.get(service, 'id');
        return typeof id === 'string' && id !== '' ? [id] : [];
      });
      let inspect: readonly unknown[] = [];
      if (ids.length > 0) {
        try {
          const inspected = await runCommand('docker', ['inspect', ...ids], {
            deadlineMs: diagnosticDeadlineMs,
            outputCapBytes: diagnosticOutputCapBytes,
          });
          inspect = parseDockerJson(inspected.stdout ?? '').map((entry) =>
            selectedInspectState(entry, retainedOutputCapBytes)
          );
        } catch (error) {
          recordDiagnosticFailure(`${phase}:container_inspect`, error);
        }
      }
      containerState.push({ phase, at: toIso(now()), services, inspect });
    } catch (error) {
      recordDiagnosticFailure(`${phase}:container_state`, error);
      containerState.push({ phase, at: toIso(now()), services, inspect: [] });
    }
  };

  const collectLogs = async (phase: LogTailObservation['phase']): Promise<void> => {
    await Promise.all(
      (['hosted-controller', 'fake-runtime'] as const).map(async (service) => {
        const at = toIso(now());
        try {
          const result = await runCommand(
            'docker',
            [...input.composeArgs, 'logs', '--no-color', '--timestamps', '--tail', '200', service],
            { deadlineMs: diagnosticDeadlineMs, outputCapBytes: diagnosticOutputCapBytes }
          );
          logTails.push({
            phase,
            service,
            at,
            configuredDeadlineMs: diagnosticDeadlineMs,
            configuredOutputCapBytes: diagnosticOutputCapBytes,
            output: opaqueText(`${result.stdout ?? ''}${result.stderr ?? ''}`, retainedOutputCapBytes),
            error: null,
          });
        } catch (error) {
          const result = metadata(error);
          logTails.push({
            phase,
            service,
            at,
            configuredDeadlineMs: diagnosticDeadlineMs,
            configuredOutputCapBytes: diagnosticOutputCapBytes,
            output: opaqueText(`${result.stdout ?? ''}${result.stderr ?? ''}`, retainedOutputCapBytes),
            error: safeError(error, retainedOutputCapBytes),
          });
        }
      })
    );
  };

  const sampleReadiness = async (): Promise<void> => {
    while (!samplerStop.signal.aborted && readiness.length < readinessObservationLimit) {
      const sampleStarted = now();
      try {
        let status: number | null;
        let readinessHeader: string | null;
        if (input.fetch === undefined) {
          const observation = await requestReadiness(input.origin, readinessDeadlineMs);
          status = observation.status;
          readinessHeader = observation.readinessHeader;
        } else {
          const observation = await requestReadinessWithFetch(
            input.fetch,
            input.origin,
            readinessDeadlineMs
          );
          status = observation.status;
          readinessHeader = observation.readinessHeader;
        }
        readiness.push({
          at: toIso(sampleStarted),
          configuredDeadlineMs: readinessDeadlineMs,
          latencyMs: Math.max(0, now() - sampleStarted),
          status,
          readinessHeader: readinessHeader === 'ready' || readinessHeader === 'starting'
            ? readinessHeader
            : readinessHeader === null ? null : '[REDACTED_HEADER]',
          transportError: null,
        });
      } catch (error) {
        readiness.push({
          at: toIso(sampleStarted),
          configuredDeadlineMs: readinessDeadlineMs,
          latencyMs: Math.max(0, now() - sampleStarted),
          status: null,
          readinessHeader: null,
          transportError: safeError(error, retainedOutputCapBytes),
        });
      }
      if (samplerStop.signal.aborted || readiness.length >= readinessObservationLimit) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, readinessIntervalMs);
        samplerStop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  };

  await Promise.all([
    runDiagnostic('before_restart:container_state_collection', () => collectState('before_restart')),
    runDiagnostic('before_restart:log_collection', () => collectLogs('before_restart')),
  ]);
  const sampler = sampleReadiness();
  let originalError: unknown;
  try {
    let stageIndex = 0;
    await restartHostedV1LifecycleOwner({
      compose: async (...args) => {
        const stage = stageNames[stageIndex] ?? `unexpected_stage_${stageIndex}`;
        stageIndex += 1;
        const stageStarted = now();
        let result: CommandResult = {};
        let error: unknown;
        try {
          result = await runCommand('docker', [...input.composeArgs, ...args], {
            deadlineMs: STAGE_DEADLINE_MS,
            outputCapBytes: STAGE_EXECUTION_CAP_BYTES,
          });
        } catch (caught) {
          error = caught;
          result = metadata(caught);
        }
        const finished = now();
        stages.push({
          stage,
          args: sanitizeArgs([...input.composeArgs, ...args], retainedOutputCapBytes),
          configuredDeadlineMs: STAGE_DEADLINE_MS,
          configuredOutputCapBytes: STAGE_EXECUTION_CAP_BYTES,
          startedAt: toIso(stageStarted),
          finishedAt: toIso(finished),
          elapsedMs: Math.max(0, finished - stageStarted),
          stdout: opaqueText(result.stdout ?? '', retainedOutputCapBytes),
          stderr: opaqueText(result.stderr ?? '', retainedOutputCapBytes),
          code: typeof result.code === 'string'
            ? safeProcessMetadata(result.code, retainedOutputCapBytes)
            : result.code ?? null,
          signal: typeof result.signal === 'string'
            ? safeProcessMetadata(result.signal, retainedOutputCapBytes)
            : result.signal ?? null,
          killed: result.killed ?? null,
          error: error === undefined ? null : safeError(error, retainedOutputCapBytes),
          classification: error === undefined ? null : classifyRestartFailure(result),
        });
        if (error !== undefined) throw error;
        return result.stdout ?? '';
      },
    });
  } catch (error) {
    originalError = error;
    await Promise.all([
      runDiagnostic(
        'failure_before_teardown:container_state_collection',
        () => collectState('failure_before_teardown')
      ),
      runDiagnostic(
        'failure_before_teardown:log_collection',
        () => collectLogs('failure_before_teardown')
      ),
    ]);
  } finally {
    samplerStop.abort();
    await sampler.catch((error) => recordDiagnosticFailure('readiness_sampler', error));
    const report = capRetainedStrings({
      schemaVersion: 1,
      startedAt,
      finishedAt: toIso(now()),
      stages,
      containerState,
      readiness,
      logTails,
      diagnosticFailures,
    }, retainedOutputCapBytes) as RestartDiagnosticReport;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          input.emit(report),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('restart_diagnostics_emit_timeout')), diagnosticDeadlineMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      recordDiagnosticFailure('emit_report', error);
    }
  }
  if (originalError !== undefined) throw originalError;
}
