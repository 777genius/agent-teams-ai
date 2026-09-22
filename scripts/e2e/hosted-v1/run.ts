import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { encodeReplayCursor } from '../../../src/features/coordination-events';
import { ProjectScanner } from '../../../src/main/services/discovery/ProjectScanner';
import {
  assertHostedV1MarkerOwnedRoot,
  createHostedV1Sandbox,
  E2E_FORBIDDEN_WORKSPACE_ID,
  E2E_PROJECT_WORKSPACE_ID,
  E2E_RUNTIME_WORKSPACE_ID,
  E2E_TEAM_ID,
  E2E_TEAM_NAME,
  E2E_TEAM_RUNTIME_WORKSPACE_ID,
  E2E_WORKSPACE_ID,
  type HostedV1Sandbox,
} from '../../../test/fixtures/hosted-v1/createSandbox';
import {
  HOSTED_V1_BROWSER_SUITES,
  parseHostedV1BrowserSuite,
  selectHostedV1BrowserCases,
} from '../../../test/fixtures/hosted-v1/browserSuites';
import { createHostedV1SharedAppImageLifecycle, removeHostedV1AppImage } from './appImageCleanup';
import { runHostedV1ForegroundSubprocess } from './foregroundSubprocess';

export { createHostedV1SharedAppImageLifecycle, removeHostedV1AppImage } from './appImageCleanup';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeFile = join(repositoryRoot, 'docker', 'docker-compose.e2e.yml');
const playwrightConfig = join(repositoryRoot, 'test', 'e2e', 'hosted-v1', 'playwright.config.ts');
const requiredDigest = /^sha256:[0-9a-f]{64}$/;
const providerEnvironmentKey =
  /(?:ANTHROPIC|CLAUDE|CODEX|OPENAI|OPENCODE|GEMINI|GOOGLE.*API|CURSOR|GITHUB_TOKEN|GH_TOKEN|API_KEY|AUTH_TOKEN|OAUTH_TOKEN)/i;
const ambientContainerContextKey = /^(?:COMPOSE_|DOCKER_CONTEXT$|DOCKER_HOST$)/u;
const sanitizedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !providerEnvironmentKey.test(key) && !ambientContainerContextKey.test(key)
  )
);
const deploymentId = 'deployment_hosted-v1-e2e';
const PLAYWRIGHT_ARTIFACT_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
const PLAYWRIGHT_ARTIFACT_FILE_MAX_BYTES = 16 * 1024;
const PLAYWRIGHT_BINARY_ARTIFACT = /\.(?:jpe?g|png|webp|webm|zip)$/iu;
const HOSTED_V1_EVIDENCE_TEXT_MAX_BYTES = 16 * 1024 * 1024;
const HOSTED_V1_SUBPROCESS_TIMEOUT_MS = 15 * 60_000;
const HOSTED_V1_DOCKER_BUILD_TIMEOUT_MS = 30 * 60_000;
const HOSTED_V1_SOURCE_HEAD_LABEL = 'org.agent-teams.hosted-e2e.source-head-commit';
const HOSTED_V1_SOURCE_PATCH_LABEL = 'org.agent-teams.hosted-e2e.source-patch-sha256';
let activeRunAbortSignal: AbortSignal | undefined;
type ScenarioMode = 'oidc' | 'oidc-viewer' | 'personal';
export {
  parseHostedV1BrowserSuite,
  selectHostedV1BrowserCases,
} from '../../../test/fixtures/hosted-v1/browserSuites';
export const CADDY_HTTPS_TARGET_PORT = 443;
const CADDY_HTTPS_PUBLISHED_PORT_MIN = 49_152;
const CADDY_HTTPS_PUBLISHED_PORT_MAX = 65_535;

export interface HostedV1ScannerEvidence {
  readonly expectedProjectFound: boolean;
  readonly expectedRuntimeWorkspaceId: string;
  readonly projectCount: number;
  readonly projects: readonly {
    readonly runtimeWorkspaceId: string;
    readonly sessionCount: number | undefined;
  }[];
}

type HostedV1InterruptSignal = 'SIGINT' | 'SIGTERM';

export interface HostedV1ProbeBodyReader {
  readonly read: () => Promise<
    Readonly<{ done: false; value: Uint8Array }> | Readonly<{ done: true; value?: Uint8Array }>
  >;
  readonly cancel: (reason?: unknown) => Promise<unknown> | unknown;
}

export interface HostedV1FetchLikeResponse {
  readonly headers: Readonly<{
    get(name: string): string | null;
  }>;
  readonly body: Readonly<{
    getReader(): HostedV1ProbeBodyReader;
  }> | null;
}

export interface HostedV1OriginalHttpResponseLike {
  /**
   * This is deliberately Playwright's public Response shape. Playwright exposes a completed
   * Buffer here, not a ReadableStream, so callers must not model it as one.
   *
   * Hosted response evidence is only eligible when Content-Length provides the transport bound
   * and Content-Encoding is identity. Content-Length frames the HTTP entity, and identity
   * encoding means Chromium cannot inflate it into a larger decoded Buffer. A response which
   * cannot provide that proof is discarded rather than treated as bounded evidence.
   */
  readonly body: () => Promise<Uint8Array>;
  /** Playwright exposes normalized response headers synchronously at the response event. */
  readonly headers: () => Readonly<Record<string, string>>;
  readonly headersArray: () => Promise<
    readonly { readonly name: string; readonly value: string }[]
  >;
  readonly request: () => Readonly<{ method(): string }>;
  readonly status: () => number;
  readonly url: () => string;
}

export interface HostedV1OriginalHttpResponseCapture {
  readonly capture: 'playwright_original_response';
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly declaredBodyBytes: number;
  readonly bodyBytes: number;
  readonly rawBody: string;
}

function parseHostedV1OriginalResponseContentLength(
  headers: readonly { readonly name: string; readonly value: string }[],
  maximumBytes: number
): number {
  const named = (name: string) => headers.filter((header) => header.name.toLowerCase() === name);
  const contentLengths = named('content-length');
  const contentEncodings = named('content-encoding');
  const transferEncodings = named('transfer-encoding');
  if (
    contentLengths.length !== 1 ||
    contentEncodings.length > 1 ||
    transferEncodings.length !== 0 ||
    (contentEncodings.length === 1 && contentEncodings[0]?.value.toLowerCase() !== 'identity')
  ) {
    throw new Error('hosted_e2e_original_response_transport_bound_invalid');
  }
  const contentLength = contentLengths[0]?.value;
  if (contentLength === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
    throw new Error('hosted_e2e_original_response_content_length_invalid');
  }
  const normalizedMaximum = String(maximumBytes);
  if (
    contentLength.length > normalizedMaximum.length ||
    (contentLength.length === normalizedMaximum.length && contentLength > normalizedMaximum)
  ) {
    throw new Error('hosted_e2e_original_response_body_too_large');
  }
  const declaredBodyBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBodyBytes)) {
    throw new Error('hosted_e2e_original_response_content_length_invalid');
  }
  return declaredBodyBytes;
}

export interface HostedV1ProbeDeadlineBudget {
  readonly overallDeadlineMs: number;
  readonly remainingMs: () => number;
  readonly nextAttemptTimeoutMs: () => number;
  readonly clipRetryDelayMs: (requestedDelayMs: number) => number;
}

export interface HostedV1FailedRunHttpProbe {
  readonly schemaVersion: 1;
  readonly reachable: boolean;
  readonly errorCode:
    | 'ECONNREFUSED'
    | 'ETIMEDOUT'
    | 'EHOSTUNREACH'
    | 'ENETUNREACH'
    | 'ABORT_ERR'
    | 'probe_failed'
    | null;
  readonly httpStatus: number | null;
  readonly readinessHeader: 'ready' | 'starting' | '[REDACTED]' | null;
}

function hostedV1HttpProbeErrorCode(
  error: unknown
): Exclude<HostedV1FailedRunHttpProbe['errorCode'], null> {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 4 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    const code = Reflect.get(candidate, 'code');
    if (
      ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR'].includes(
        String(code)
      )
    ) {
      return code as Exclude<HostedV1FailedRunHttpProbe['errorCode'], 'probe_failed' | null>;
    }
    if (Reflect.get(candidate, 'name') === 'AbortError') return 'ABORT_ERR';
    candidate = Reflect.get(candidate, 'cause');
  }
  return 'probe_failed';
}

/** Captures only allowlisted health metadata; response bodies and error messages are discarded. */
export async function captureHostedV1FailedRunHttpProbe(input: {
  readonly origin: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<HostedV1FailedRunHttpProbe> {
  const timeoutMs = input.timeoutMs ?? 1_500;
  const origin = new URL(input.origin);
  if (
    origin.protocol !== 'http:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000
  ) {
    throw new Error('hosted_e2e_failed_http_probe_input_invalid');
  }
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (input.fetch ?? globalThis.fetch)(new URL('/api/auth/status', origin), {
        credentials: 'omit',
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(Object.assign(new Error('probe deadline'), { code: 'ETIMEDOUT' }));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
    const rawHeader = response.headers.get('x-agent-teams-lifecycle-owner-readiness');
    void response.body?.cancel().catch(() => undefined);
    return Object.freeze({
      schemaVersion: 1,
      reachable: true,
      errorCode: null,
      httpStatus:
        Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : null,
      readinessHeader:
        rawHeader === 'ready' || rawHeader === 'starting'
          ? rawHeader
          : rawHeader === null
            ? null
            : '[REDACTED]',
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: 1,
      reachable: false,
      errorCode: hostedV1HttpProbeErrorCode(error),
      httpStatus: null,
      readinessHeader: null,
    });
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    controller.abort();
  }
}

function assertHostedV1ProbeDuration(value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`hosted_e2e_probe_${name}_invalid`);
  }
}

/**
 * Creates one fixed, monotonic deadline for a retrying probe. Every attempt and retry delay is
 * clipped to the same remaining overall budget, so retries cannot reset the operation deadline.
 */
export function createHostedV1ProbeDeadlineBudget(input: {
  readonly overallTimeoutMs: number;
  readonly perAttemptTimeoutMs: number;
  readonly now?: () => number;
}): HostedV1ProbeDeadlineBudget {
  assertHostedV1ProbeDuration(input.overallTimeoutMs, 'overall_timeout', false);
  assertHostedV1ProbeDuration(input.perAttemptTimeoutMs, 'attempt_timeout', false);
  const clock = input.now ?? (() => performance.now());
  const readClock = (): number => {
    const value = clock();
    if (!Number.isFinite(value)) throw new Error('hosted_e2e_probe_clock_invalid');
    return value;
  };
  let lastObservedNowMs = readClock();
  const overallDeadlineMs = lastObservedNowMs + input.overallTimeoutMs;
  if (!Number.isFinite(overallDeadlineMs)) {
    throw new Error('hosted_e2e_probe_overall_timeout_invalid');
  }
  const remainingMs = (): number => {
    lastObservedNowMs = Math.max(lastObservedNowMs, readClock());
    return Math.max(0, Math.floor(overallDeadlineMs - lastObservedNowMs));
  };
  const requireRemainingMs = (): number => {
    const remaining = remainingMs();
    if (remaining <= 0) throw new Error('hosted_e2e_probe_overall_deadline_exhausted');
    return remaining;
  };
  return Object.freeze({
    overallDeadlineMs,
    remainingMs,
    nextAttemptTimeoutMs: () => Math.min(input.perAttemptTimeoutMs, requireRemainingMs()),
    clipRetryDelayMs: (requestedDelayMs: number) => {
      assertHostedV1ProbeDuration(requestedDelayMs, 'retry_delay', true);
      return Math.min(requestedDelayMs, requireRemainingMs());
    },
  });
}

function hostedV1ProbeAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('hosted_e2e_probe_aborted', { cause: signal.reason });
}

function cancelHostedV1ProbeReader(reader: HostedV1ProbeBodyReader, reason: unknown): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
  } catch {
    // Preserve the primary bound/abort failure; cancellation is best-effort teardown.
  }
}

function cancelHostedV1ProbeBody(response: HostedV1FetchLikeResponse, reason: unknown): void {
  if (response.body === null) return;
  try {
    cancelHostedV1ProbeReader(response.body.getReader(), reason);
  } catch {
    // Preserve the primary header validation failure if the body cannot be locked.
  }
}

function readHostedV1ProbeChunk(
  reader: HostedV1ProbeBodyReader,
  signal: AbortSignal,
  cancel: (reason: unknown) => void
): Promise<
  Readonly<{ done: false; value: Uint8Array }> | Readonly<{ done: true; value?: Uint8Array }>
> {
  if (signal.aborted) {
    const reason = hostedV1ProbeAbortReason(signal);
    cancel(reason);
    return Promise.reject(reason);
  }
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      const reason = hostedV1ProbeAbortReason(signal);
      cancel(reason);
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    // Cover an abort racing between the pre-check and listener registration.
    if (signal.aborted) onAbort();
  });
  return Promise.race([Promise.resolve().then(() => reader.read()), aborted]).finally(
    removeAbortListener
  );
}

/** Reads a Fetch-like response body while refusing to accept more than `maximumBytes` raw bytes. */
export async function readHostedV1ProbeResponseBody(
  response: HostedV1FetchLikeResponse,
  input: {
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }
): Promise<string> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0) {
    throw new Error('hosted_e2e_probe_body_byte_limit_invalid');
  }
  if (input.signal.aborted) {
    const reason = hostedV1ProbeAbortReason(input.signal);
    cancelHostedV1ProbeBody(response, reason);
    throw reason;
  }

  let contentLength: string | null;
  try {
    contentLength = response.headers.get('content-length');
  } catch (cause) {
    const error = new Error('hosted_e2e_probe_content_length_invalid', { cause });
    cancelHostedV1ProbeBody(response, error);
    throw error;
  }
  let declaredContentLength: number | null = null;
  if (contentLength !== null) {
    if (!/^[0-9]+$/u.test(contentLength)) {
      const error = new Error('hosted_e2e_probe_content_length_invalid');
      cancelHostedV1ProbeBody(response, error);
      throw error;
    }
    const normalizedContentLength = contentLength.replace(/^0+/u, '') || '0';
    const maximumBytes = String(input.maximumBytes);
    if (
      normalizedContentLength.length > maximumBytes.length ||
      (normalizedContentLength.length === maximumBytes.length &&
        normalizedContentLength > maximumBytes)
    ) {
      const error = new Error('hosted_e2e_probe_body_byte_limit_exceeded');
      cancelHostedV1ProbeBody(response, error);
      throw error;
    }
    declaredContentLength = Number(normalizedContentLength);
  }

  if (response.body === null) {
    if (declaredContentLength !== null && declaredContentLength > 0) {
      throw new Error('hosted_e2e_probe_body_missing');
    }
    return '';
  }

  const reader = response.body.getReader();
  let cancelled = false;
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    cancelHostedV1ProbeReader(reader, reason);
  };
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const result = await readHostedV1ProbeChunk(reader, input.signal, cancel);
      if (result.done) {
        if (result.value !== undefined) {
          const error = new Error('hosted_e2e_probe_body_chunk_invalid');
          cancel(error);
          throw error;
        }
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        const error = new Error('hosted_e2e_probe_body_chunk_invalid');
        cancel(error);
        throw error;
      }
      if (result.value.byteLength > input.maximumBytes - receivedBytes) {
        const error = new Error('hosted_e2e_probe_body_byte_limit_exceeded');
        cancel(error);
        throw error;
      }
      receivedBytes += result.value.byteLength;
      // Do not retain an arbitrarily large backing buffer through a small Uint8Array view.
      chunks.push(new Uint8Array(result.value));
    }
  } catch (error) {
    cancel(error);
    throw error;
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (cause) {
    throw new Error('hosted_e2e_probe_body_utf8_invalid', { cause });
  }
}

/**
 * Captures an already-observed Playwright response without replaying its request. `body()` is
 * started before the first await, because a navigation may otherwise invalidate the response
 * between response observation and body retrieval. It is not a stream: Content-Length plus
 * identity encoding is the transport-level bound on the Buffer Playwright creates.
 *
 * A caller that owns a route/CDP transport can supply `cancel` to terminate that transport when
 * headers are invalid or the deadline expires. A native Playwright Response has no cancellation
 * API; cancellation is therefore intentionally best-effort and never awaited by this helper.
 */
export async function captureOriginalHostedV1HttpResponse(
  response: HostedV1OriginalHttpResponseLike,
  input: {
    readonly maximumBytes: number;
    readonly overallDeadlineAtMs: number;
    readonly cancel?: (reason: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
  }
): Promise<HostedV1OriginalHttpResponseCapture> {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 0 ||
    !Number.isSafeInteger(input.overallDeadlineAtMs)
  ) {
    throw new Error('hosted_e2e_original_response_limits_invalid');
  }
  const remainingMs = input.overallDeadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error('hosted_e2e_original_response_deadline');

  // Snapshot and preflight Playwright's synchronous normalized headers before asking Playwright
  // to allocate a Buffer. This is the hard cap: HTTP Content-Length frames the identity-encoded
  // response entity. Do not replace this with a fictional `body.getReader()` API: Response only
  // exposes `body(): Promise<Buffer>`.
  const request = response.request();
  const method = request.method();
  const url = response.url();
  const status = response.status();
  const controller = new AbortController();
  let cancelled = false;
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    controller.abort(reason);
    try {
      // A route/CDP owner can terminate the wire request. Do not await an uncooperative cancel:
      // the evidence operation itself must still settle at the fixed deadline.
      void Promise.resolve(input.cancel?.(reason, controller.signal)).catch(() => undefined);
    } catch {
      // Preserve the evidence failure; transport teardown is best effort.
    }
  };
  let declaredBodyBytes: number;
  try {
    declaredBodyBytes = parseHostedV1OriginalResponseContentLength(
      Object.entries(response.headers()).map(([name, value]) => ({ name, value })),
      input.maximumBytes
    );
  } catch (cause) {
    cancel(cause);
    throw cause;
  }

  // This remains before the first await, so an immediate navigation cannot invalidate the
  // already-observed response. Exact raw headers are checked below while this bounded operation
  // is in flight, preserving duplicate-header evidence that the normalized view cannot represent.
  let bodyPromise: Promise<Uint8Array>;
  try {
    bodyPromise = Promise.resolve(response.body());
  } catch (cause) {
    const error = new Error('hosted_e2e_original_response_body_unavailable', { cause });
    cancel(error);
    throw error;
  }
  // The losing body promise may reject after a header/deadline failure. Observe it now so a
  // cancelled navigation cannot become an unhandled rejection after this capture has settled.
  void bodyPromise.catch(() => undefined);
  let headersPromise: Promise<number>;
  try {
    headersPromise = Promise.resolve(response.headersArray()).then((headers) =>
      parseHostedV1OriginalResponseContentLength(headers, input.maximumBytes)
    );
  } catch (cause) {
    cancel(cause);
    throw cause;
  }
  // Attach cancellation immediately so invalid headers cannot leave the route/CDP request alive.
  void headersPromise.catch(cancel);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const deadlineError = new Error('hosted_e2e_original_response_deadline');
  const [exactDeclaredBodyBytes, bodyBytes] = await Promise.race([
    Promise.all([headersPromise, bodyPromise]),
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => {
          controller.abort(deadlineError);
          reject(deadlineError);
        },
        remainingMs
      );
    }),
  ])
    .catch((error: unknown) => {
      cancel(error);
      throw error;
    })
    .finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
    });
  if (!(bodyBytes instanceof Uint8Array)) {
    const error = new Error('hosted_e2e_original_response_body_invalid');
    cancel(error);
    throw error;
  }
  if (bodyBytes.byteLength > input.maximumBytes) {
    const error = new Error('hosted_e2e_original_response_body_too_large');
    cancel(error);
    throw error;
  }
  if (
    exactDeclaredBodyBytes !== declaredBodyBytes ||
    bodyBytes.byteLength !== declaredBodyBytes ||
    bodyBytes.byteLength !== exactDeclaredBodyBytes
  ) {
    const error = new Error('hosted_e2e_original_response_content_length_mismatch');
    cancel(error);
    throw error;
  }
  let rawBody: string;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
  } catch {
    const error = new Error('hosted_e2e_original_response_body_utf8_invalid');
    cancel(error);
    throw error;
  }
  return Object.freeze({
    capture: 'playwright_original_response',
    method,
    url,
    status,
    declaredBodyBytes,
    bodyBytes: bodyBytes.byteLength,
    rawBody,
  });
}

export function registerHostedV1InterruptHandlers(input: {
  readonly once: (signal: HostedV1InterruptSignal, listener: () => void) => void;
  readonly remove: (signal: HostedV1InterruptSignal, listener: () => void) => void;
}): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  const interrupt = (signal: HostedV1InterruptSignal): void => {
    controller.abort(new Error(`hosted_e2e_interrupted:${signal}`));
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  input.once('SIGINT', onSigint);
  input.once('SIGTERM', onSigterm);
  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      input.remove('SIGINT', onSigint);
      input.remove('SIGTERM', onSigterm);
    },
  });
}

export function beginHostedV1CleanupSignalScope(input: {
  readonly activeSignal: AbortSignal;
  readonly replaceActiveSignal: (signal: AbortSignal) => void;
}): Readonly<{
  readonly cleanupSignal: AbortSignal;
  readonly interruptedSignal: AbortSignal;
  restore(): void;
}> {
  const cleanupController = new AbortController();
  input.replaceActiveSignal(cleanupController.signal);
  let restored = false;
  return Object.freeze({
    cleanupSignal: cleanupController.signal,
    interruptedSignal: input.activeSignal,
    restore: () => {
      if (restored) return;
      restored = true;
      input.replaceActiveSignal(input.activeSignal);
    },
  });
}

export function mergeHostedV1CleanupInterruption(
  interruptedSignal: AbortSignal,
  runnerError: unknown
): unknown {
  if (!interruptedSignal.aborted || runnerError !== null) return runnerError;
  return interruptedSignal.reason instanceof Error
    ? interruptedSignal.reason
    : new Error('hosted_e2e_interrupted');
}

export type ProjectAccessClassification =
  | 'grant_null'
  | 'grant_unavailable'
  | 'project_admitted'
  | 'public_mapping_mismatch'
  | 'registration_inactive'
  | 'scanner_empty'
  | 'scanner_unavailable';

interface HostedV1ControllerProjectEvidence {
  readonly exactExpectedPublicProject: boolean;
  readonly projectCount: number | null;
  readonly rawRuntimeIdentityAbsent: boolean;
  readonly rawRuntimePathAbsent: boolean;
  readonly status: 'observed' | 'unavailable';
}

interface HostedV1GrantEvidence {
  readonly classification: ProjectAccessClassification;
  readonly expectedPublicWorkspaceId: string;
  readonly expectedPublicWorkspaceMapped: boolean;
  readonly expectedRuntimeWorkspaceId: string;
  readonly fixturePrincipalFound: boolean;
  readonly fixturePrincipalGrantFound: boolean;
  readonly controllerProjectEvidence: HostedV1ControllerProjectEvidence;
  readonly registrationStatus: string | null;
  readonly schemaVersion: 1;
  readonly storageLayout: 'app-data/data/storage/app.db';
}

interface ComposeUpWithExplicitPortInput {
  readonly buildImage?: () => Promise<void>;
  readonly createEnvironment: (port: number) => NodeJS.ProcessEnv;
  readonly publishedPort: number;
  readonly readCaddyPublishers: (environment: NodeJS.ProcessEnv) => Promise<string>;
  readonly startCaddy: (environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly startRemainingServices: (environment: NodeJS.ProcessEnv) => Promise<void>;
}

interface BuildHostedV1AppImageInput {
  readonly composeArgs: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly runDocker: (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    timeoutMs: number
  ) => Promise<void>;
}

export interface HostedV1SourceDeclaration {
  readonly schemaVersion: 1;
  readonly declaration: 'git-head-and-working-tree-patch-digest';
  readonly headCommit: string;
  readonly patchBytes: number;
  readonly patchSha256: string;
  readonly untrackedPaths: 0;
}

export interface HostedV1AppImageEvidence {
  readonly schemaVersion: 1;
  readonly appImage: string;
  readonly imageId: string;
  readonly repoDigests: readonly string[];
  readonly sourceDeclarationCorrelation: {
    readonly headCommit: string;
    readonly patchSha256: string;
  };
}

export async function buildHostedV1AppImage(input: BuildHostedV1AppImageInput): Promise<void> {
  await input.runDocker(
    [...input.composeArgs, 'build', 'hosted-controller'],
    input.environment,
    HOSTED_V1_DOCKER_BUILD_TIMEOUT_MS
  );
}

/**
 * A production owner handoff is consumed after its first successful readiness lease. Replacing the
 * owner socket therefore requires a fresh signed manifest and a controller process that admits
 * that successor; reconnecting the old controller across a new socket inode is intentionally
 * forbidden.
 */
export async function restartHostedV1LifecycleOwner(input: {
  readonly compose: (...args: readonly string[]) => Promise<string>;
}): Promise<void> {
  await input.compose('stop', '--timeout', '45', 'hosted-controller');
  await input.compose('restart', 'fake-runtime');
  await input.compose('up', '--no-build', '--detach', '--wait', '--no-deps', 'fake-runtime');
  await input.compose('up', '--no-build', '--detach', '--wait', '--no-deps', 'hosted-controller');
}

export function markerDerivedCaddyPublishedPort(marker: string): number {
  if (!/^[0-9a-f]{48}$/u.test(marker)) throw new Error('hosted_e2e_marker_invalid');
  const range = CADDY_HTTPS_PUBLISHED_PORT_MAX - CADDY_HTTPS_PUBLISHED_PORT_MIN + 1;
  return CADDY_HTTPS_PUBLISHED_PORT_MIN + (Number.parseInt(marker.slice(0, 8), 16) % range);
}

export function allocateHostedV1CaddyPublishedPorts(markers: readonly string[]): readonly number[] {
  const range = CADDY_HTTPS_PUBLISHED_PORT_MAX - CADDY_HTTPS_PUBLISHED_PORT_MIN + 1;
  const used = new Set<number>();
  return markers.map((marker) => {
    let port = markerDerivedCaddyPublishedPort(marker);
    while (used.has(port)) {
      port = CADDY_HTTPS_PUBLISHED_PORT_MIN + ((port - CADDY_HTTPS_PUBLISHED_PORT_MIN + 1) % range);
    }
    used.add(port);
    return port;
  });
}

export function parseDockerComposeCaddyPort(output: string, expectedPublishedPort: number): number {
  let observation: unknown;
  try {
    observation = JSON.parse(output);
  } catch {
    throw new Error('hosted_e2e_caddy_port_invalid');
  }
  const container: unknown = Array.isArray(observation)
    ? observation.length === 1
      ? observation[0]
      : null
    : observation;
  if (
    typeof container !== 'object' ||
    container === null ||
    !('Service' in container) ||
    container.Service !== 'caddy' ||
    !('Publishers' in container) ||
    !Array.isArray(container.Publishers)
  ) {
    throw new Error('hosted_e2e_caddy_port_invalid');
  }
  let publishedCaddyPort: number | null = null;
  for (const publisher of container.Publishers) {
    if (typeof publisher !== 'object' || publisher === null) {
      throw new Error('hosted_e2e_caddy_port_invalid');
    }
    const url = 'URL' in publisher ? publisher.URL : undefined;
    const hostIp = 'HostIp' in publisher ? publisher.HostIp : undefined;
    const port = 'PublishedPort' in publisher ? publisher.PublishedPort : undefined;
    const targetPort = 'TargetPort' in publisher ? publisher.TargetPort : undefined;
    const protocol = 'Protocol' in publisher ? publisher.Protocol : undefined;
    if (
      (url !== undefined && typeof url !== 'string') ||
      (hostIp !== undefined && typeof hostIp !== 'string') ||
      typeof port !== 'number' ||
      !Number.isSafeInteger(port) ||
      port < 0 ||
      typeof targetPort !== 'number' ||
      !Number.isSafeInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65_535 ||
      (protocol !== 'tcp' && protocol !== 'udp')
    ) {
      throw new Error('hosted_e2e_caddy_port_invalid');
    }
    if (port === 0) {
      if ((url ?? '') !== '' || (hostIp ?? '') !== '') {
        throw new Error('hosted_e2e_caddy_port_invalid');
      }
      continue;
    }
    const host = url === '' || url === undefined ? hostIp : url;
    if (
      publishedCaddyPort !== null ||
      (url !== undefined && hostIp !== undefined && url !== '' && url !== hostIp) ||
      host !== '127.0.0.1' ||
      targetPort !== CADDY_HTTPS_TARGET_PORT ||
      protocol !== 'tcp' ||
      port < CADDY_HTTPS_PUBLISHED_PORT_MIN ||
      port > CADDY_HTTPS_PUBLISHED_PORT_MAX ||
      port !== expectedPublishedPort
    ) {
      throw new Error('hosted_e2e_caddy_port_invalid');
    }
    publishedCaddyPort = port;
  }
  if (publishedCaddyPort === null) throw new Error('hosted_e2e_caddy_port_invalid');
  return publishedCaddyPort;
}

export function assertDockerComposeServiceNotPublished(
  output: string,
  expectedService: 'fake-runtime' | 'hosted-controller' | 'synthetic-oidc'
): void {
  let observation: unknown;
  try {
    observation = JSON.parse(output);
  } catch {
    throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
  }
  const container: unknown = Array.isArray(observation)
    ? observation.length === 1
      ? observation[0]
      : null
    : observation;
  if (
    typeof container !== 'object' ||
    container === null ||
    !('Service' in container) ||
    container.Service !== expectedService ||
    !('Publishers' in container) ||
    !Array.isArray(container.Publishers)
  ) {
    throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
  }
  for (const publisher of container.Publishers) {
    if (typeof publisher !== 'object' || publisher === null) {
      throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
    }
    const url = 'URL' in publisher ? publisher.URL : undefined;
    const hostIp = 'HostIp' in publisher ? publisher.HostIp : undefined;
    const publishedPort = 'PublishedPort' in publisher ? publisher.PublishedPort : undefined;
    const targetPort = 'TargetPort' in publisher ? publisher.TargetPort : undefined;
    const protocol = 'Protocol' in publisher ? publisher.Protocol : undefined;
    if (
      typeof publishedPort !== 'number' ||
      !Number.isSafeInteger(publishedPort) ||
      publishedPort < 0
    ) {
      throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
    }
    if (publishedPort > 0) {
      throw new Error(`hosted_e2e_private_listener_published:${expectedService}`);
    }
    if (
      (url !== undefined && typeof url !== 'string') ||
      (hostIp !== undefined && typeof hostIp !== 'string') ||
      typeof targetPort !== 'number' ||
      !Number.isSafeInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65_535 ||
      (protocol !== 'tcp' && protocol !== 'udp')
    ) {
      throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
    }
    if ((url ?? '') !== '' || (hostIp ?? '') !== '') {
      throw new Error(`hosted_e2e_private_listener_observation_invalid:${expectedService}`);
    }
  }
}

export async function runComposeUpWithExplicitPort(
  input: ComposeUpWithExplicitPortInput
): Promise<NodeJS.ProcessEnv> {
  await input.buildImage?.();
  const environment = input.createEnvironment(input.publishedPort);
  await input.startCaddy(environment);
  parseDockerComposeCaddyPort(await input.readCaddyPublishers(environment), input.publishedPort);
  await input.startRemainingServices(environment);
  return environment;
}

export async function restoreHostedV1NodeAbi(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly runNode: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<void> {
  await input.runNode(['scripts/ci/rebuild-better-sqlite3-node.cjs'], input.environment);
}

export function createHostedV1SourceDeclaration(input: {
  readonly headCommit: string;
  readonly patch: string;
  readonly untracked: string;
}): HostedV1SourceDeclaration {
  if (!/^[0-9a-f]{40}$/u.test(input.headCommit)) {
    throw new Error('hosted_e2e_source_head_invalid');
  }
  if (input.untracked.length !== 0) {
    throw new Error('hosted_e2e_untracked_source_forbidden');
  }
  return Object.freeze({
    schemaVersion: 1,
    declaration: 'git-head-and-working-tree-patch-digest',
    headCommit: input.headCommit,
    patchBytes: Buffer.byteLength(input.patch),
    patchSha256: createHash('sha256').update(input.patch).digest('hex'),
    untrackedPaths: 0,
  });
}

export function parseHostedV1AppImageEvidence(
  output: string,
  appImage: string,
  source: HostedV1SourceDeclaration
): HostedV1AppImageEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('hosted_e2e_app_image_inspection_invalid');
  }
  const image = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  if (typeof image !== 'object' || image === null) {
    throw new Error('hosted_e2e_app_image_inspection_invalid');
  }
  const candidate = image as {
    readonly Config?: { readonly Labels?: Record<string, unknown> };
    readonly Id?: unknown;
    readonly RepoDigests?: unknown;
    readonly RepoTags?: unknown;
  };
  const labels = candidate.Config?.Labels;
  if (
    typeof candidate.Id !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.Id) ||
    !Array.isArray(candidate.RepoTags) ||
    !candidate.RepoTags.every((tag) => typeof tag === 'string') ||
    !candidate.RepoTags.includes(appImage) ||
    !Array.isArray(candidate.RepoDigests) ||
    !candidate.RepoDigests.every((digest) => typeof digest === 'string') ||
    typeof labels !== 'object' ||
    labels === null ||
    labels[HOSTED_V1_SOURCE_HEAD_LABEL] !== source.headCommit ||
    labels[HOSTED_V1_SOURCE_PATCH_LABEL] !== source.patchSha256
  ) {
    throw new Error('hosted_e2e_app_image_inspection_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    appImage,
    imageId: candidate.Id,
    repoDigests: Object.freeze([...candidate.RepoDigests].sort()),
    sourceDeclarationCorrelation: Object.freeze({
      headCommit: source.headCommit,
      patchSha256: source.patchSha256,
    }),
  });
}

function envDigest(
  name: 'NODE_IMAGE_DIGEST' | 'CADDY_IMAGE_DIGEST' | 'KEYCLOAK_IMAGE_DIGEST'
): string {
  const value = process.env[name];
  if (!value || !requiredDigest.test(value)) {
    throw new Error(`${name} must be an audited sha256 digest`);
  }
  return value;
}

async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly capture?: boolean;
    readonly timeoutMs?: number;
    readonly trim?: boolean;
  } = {}
): Promise<string> {
  const timeout = options.timeoutMs ?? HOSTED_V1_SUBPROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('hosted_e2e_subprocess_timeout_invalid');
  }
  if (options.capture) {
    const result = await execFileAsync(command, [...args], {
      cwd: repositoryRoot,
      env: options.env ?? sanitizedEnvironment,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      signal: activeRunAbortSignal,
      timeout,
    });
    const stdout = String(result.stdout);
    return options.trim === false ? stdout : stdout.trim();
  }
  await runHostedV1ForegroundSubprocess({
    args,
    command,
    cwd: repositoryRoot,
    environment: options.env ?? sanitizedEnvironment,
    signal: activeRunAbortSignal,
    timeoutMs: timeout,
  });
  return '';
}

async function collectHostedV1SourceDeclaration(): Promise<HostedV1SourceDeclaration> {
  const [headCommit, patch, untracked] = await Promise.all([
    run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { capture: true }),
    run('git', ['diff', '--binary', '--full-index', 'HEAD', '--', '.'], {
      capture: true,
      trim: false,
    }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      capture: true,
      trim: false,
    }),
  ]);
  return createHostedV1SourceDeclaration({ headCommit, patch, untracked });
}

async function inspectHostedV1AppImage(
  appImage: string,
  source: HostedV1SourceDeclaration,
  environment: NodeJS.ProcessEnv
): Promise<HostedV1AppImageEvidence> {
  const output = await run('docker', ['image', 'inspect', appImage], {
    capture: true,
    env: environment,
  });
  return parseHostedV1AppImageEvidence(output, appImage, source);
}

function safeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map((entry) => safeError(entry)).join('; ');
    const cause = error.cause === undefined ? '' : `; cause=${safeError(error.cause)}`;
    return `${error.message}; errors=[${nested}]${cause}`;
  }
  if (error instanceof Error) {
    return error.cause === undefined
      ? error.message
      : `${error.message}; cause=${safeError(error.cause)}`;
  }
  return String(error);
}

export function assertNoComposeResourcesRemain(input: {
  readonly containers: string;
  readonly networks: string;
  readonly volumes: string;
}): void {
  if (input.containers !== '' || input.networks !== '' || input.volumes !== '') {
    throw new Error('hosted_e2e_compose_orphans_remain');
  }
}

export function boundHostedV1EvidenceUtf8(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('hosted_e2e_evidence_byte_limit_invalid');
  }
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return value;
  return new TextDecoder('utf-8').decode(encoded.subarray(0, maximumBytes), { stream: true });
}

function boundHostedV1EvidenceDocument(
  value: string,
  kind: 'json' | 'text',
  maximumBytes: number
): string {
  const fullRedactedBytes = Buffer.byteLength(value);
  if (fullRedactedBytes <= maximumBytes) return value;
  const fullRedactedSha256 = createHash('sha256').update(value, 'utf8').digest('hex');
  let preview = boundHostedV1EvidenceUtf8(value, Math.max(0, Math.floor(maximumBytes / 2)));
  for (;;) {
    const envelope = JSON.stringify({
      schemaVersion: 1,
      kind,
      fullRedactedBytes,
      fullRedactedSha256,
      truncated: true,
      preview,
    });
    if (Buffer.byteLength(envelope) <= maximumBytes) return envelope;
    if (preview.length === 0) throw new Error('hosted_e2e_evidence_bound_too_small');
    preview = boundHostedV1EvidenceUtf8(preview, Math.floor(Buffer.byteLength(preview) / 2));
  }
}

export function redactEvidence(
  value: string,
  sandbox: Pick<HostedV1Sandbox, 'root' | 'lifecycleTrustAnchor'>,
  pairingCode: string | null,
  maximumBytes = HOSTED_V1_EVIDENCE_TEXT_MAX_BYTES
): string {
  const placeholderForKey = (key: string): string | null => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (normalized === 'authorization' || normalized === 'proxyauthorization') {
      return '<authorization>';
    }
    if (
      normalized === 'xagentteamscsrf' ||
      normalized === 'xcsrftoken' ||
      normalized === 'csrf' ||
      normalized.includes('csrftoken')
    ) {
      return '<csrf-token>';
    }
    if (normalized === 'cookie' || normalized === 'setcookie') return '<cookie>';
    if (normalized === 'code' || normalized === 'state') return '<oidc-value>';
    if (normalized.includes('trustanchor')) return '<trust-anchor>';
    if (
      normalized.includes('password') ||
      normalized.includes('passwd') ||
      normalized.includes('passphrase')
    ) {
      return '<password>';
    }
    if (
      normalized.includes('secret') ||
      normalized.includes('credential') ||
      normalized.includes('privatekey')
    ) {
      return '<secret>';
    }
    if (normalized.includes('token') || normalized.includes('apikey')) return '<token>';
    return null;
  };
  const redactText = (text: string): string => {
    let redacted = text
      .replaceAll(repositoryRoot, '<repository-root>')
      .replaceAll(sandbox.root, '<sandbox-root>')
      .replaceAll('/workspaces/sandbox', '<runtime-workspace-root>')
      .replaceAll('/data/.claude', '<runtime-claude-root>')
      .replaceAll('/data/.agent-teams', '<runtime-app-data-root>')
      .replaceAll('/run/agent-teams-orchestrator', '<lifecycle-runtime-root>')
      .replaceAll('/run/agent-teams', '<runtime-state-root>')
      .replaceAll(sandbox.lifecycleTrustAnchor, '<trust-anchor>');
    if (pairingCode) redacted = redacted.replaceAll(pairingCode, '<pairing-code>');
    return redacted
      .replace(/(^|[\r\n]\s*)((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gimu, '$1$2<cookie>')
      .replace(/(__Host-agent-teams-[A-Za-z0-9_-]+["':=\s]+)[^;,\s"']+/gu, '$1<cookie>')
      .replace(/([?&](?:code|state)=)[^&\s"']+/giu, '$1<oidc-value>')
      .replace(
        /([?&](?:api[_-]?key|[^&=]*(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^&=]*)=)[^&\s"'#]*/giu,
        '$1<sensitive-value>'
      )
      .replace(/(["']?(?:code|state)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{16,}/giu, '$1<oidc-value>')
      .replace(
        /((?:x-agent-teams-csrf|csrf[_-]?token|csrfToken)["':=\s]+)[A-Za-z0-9_-]{32,}/giu,
        '$1<csrf-token>'
      )
      .replace(
        /((?:authorization|proxy[_-]?authorization)["':=\s]+)(?:bearer\s+)?[^\r\n,;]+/giu,
        '$1<authorization>'
      )
      .replace(
        /((?:^|\s)--?(?:api[_-]?key|[^\s]{0,128}(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^\s]{0,128})\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gimu,
        '$1<sensitive-value>'
      )
      .replace(
        /((["']?)([^\s"':=,;]{1,256})\2\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
        (match: string, prefix: string) => {
          const key = /["']?([^\s"':=]+)["']?\s*[:=]\s*$/u.exec(prefix)?.[1] ?? '';
          const placeholder = placeholderForKey(key);
          return placeholder === null ? match : `${prefix}${placeholder}`;
        }
      )
      .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, '<jwt>');
  };
  const redactJson = (input: unknown, key = ''): unknown => {
    const placeholder = placeholderForKey(key);
    if (placeholder !== null) {
      if (typeof input === 'string') return placeholder;
      if (Array.isArray(input)) return input.map(() => placeholder);
      if (input !== null) return placeholder;
    }
    if (typeof input === 'string') return redactText(input);
    if (Array.isArray(input)) return input.map((item) => redactJson(item));
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input).map(([entryKey, entryValue]) => [
          entryKey,
          redactJson(entryValue, entryKey),
        ])
      );
    }
    return input;
  };
  try {
    return boundHostedV1EvidenceDocument(
      JSON.stringify(redactJson(JSON.parse(value))),
      'json',
      maximumBytes
    );
  } catch {
    return boundHostedV1EvidenceDocument(redactText(value), 'text', maximumBytes);
  }
}

export async function sanitizePlaywrightEvidence(
  directory: string,
  sandbox: HostedV1Sandbox,
  pairingCode: string | null
): Promise<void> {
  let retainedBytes = 0;
  const assertNoSymlinkPath = async (target: string): Promise<void> => {
    const absolute = resolve(target);
    const root = parse(absolute).root;
    let current = root;
    for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  };
  await assertNoSymlinkPath(directory);
  // A canonical commit and its interrupted private receipt can both name the
  // same immutable payload. Count payload identity, rather than commit-file
  // paths, so final processing makes the same retention decision as writer
  // admission.
  const retainedPayloadIdentities = new Set<string>();
  // The atomic attachment writer publishes immutable payload bytes plus a
  // digest-bearing commit record.  Post-processing may redact ordinary
  // Playwright output, but it must never rewrite either side of a valid
  // publication or it would make the evidence commit self-invalidating.
  const committedArtifactPaths = new Set<string>();
  const collectCommittedArtifacts = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      if (entry.isDirectory()) {
        await assertNoSymlinkPath(path);
        await collectCommittedArtifacts(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let commit: unknown;
      try {
        await assertNoSymlinkPath(path);
        commit = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (
        commit === null ||
        typeof commit !== 'object' ||
        (commit as { schemaVersion?: unknown }).schemaVersion !== 1 ||
        (commit as { kind?: unknown }).kind !== 'hosted-v1-artifact-commit' ||
        typeof (commit as { payload?: unknown }).payload !== 'string' ||
        !Number.isSafeInteger((commit as { byteLength?: unknown }).byteLength) ||
        (commit as { byteLength: number }).byteLength < 0 ||
        typeof (commit as { sha256?: unknown }).sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test((commit as { sha256: string }).sha256)
      ) continue;
      const payload = (commit as { payload: string }).payload;
      if (basename(payload) !== payload || !payload.endsWith('.payload')) continue;
      const payloadPath = join(dirname(path), payload);
      let bytes: Buffer;
      try {
        await assertNoSymlinkPath(payloadPath);
        bytes = await readFile(payloadPath);
        if (
          bytes.byteLength !== (commit as { byteLength: number }).byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== (commit as { sha256: string }).sha256
        ) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const identity = `${resolve(payloadPath)}\u0000${bytes.byteLength}\u0000${(commit as { sha256: string }).sha256}`;
      if (!retainedPayloadIdentities.has(identity)) {
        if (
          bytes.byteLength > PLAYWRIGHT_ARTIFACT_FILE_MAX_BYTES ||
          retainedBytes + bytes.byteLength > PLAYWRIGHT_ARTIFACT_TOTAL_MAX_BYTES
        ) {
          throw new Error('hosted_e2e_playwright_committed_artifact_retention_budget_exceeded');
        }
        retainedPayloadIdentities.add(identity);
        retainedBytes += bytes.byteLength;
      }
      committedArtifactPaths.add(path);
      committedArtifactPaths.add(payloadPath);
    }
  };
  await collectCommittedArtifacts(directory);
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      if (entry.isDirectory()) {
        await assertNoSymlinkPath(path);
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('hosted_e2e_playwright_artifact_type_forbidden');
      await assertNoSymlinkPath(path);
      if (committedArtifactPaths.has(path)) continue;
      if (PLAYWRIGHT_BINARY_ARTIFACT.test(entry.name)) {
        await rm(path);
        continue;
      }
      const raw = await readFile(path);
      if (raw.includes(0)) {
        await rm(path);
        continue;
      }
      const available = Math.max(0, PLAYWRIGHT_ARTIFACT_TOTAL_MAX_BYTES - retainedBytes);
      if (available === 0) {
        await rm(path);
        continue;
      }
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        await rm(path);
        continue;
      }
      const redacted = redactEvidence(
        decoded,
        sandbox,
        pairingCode,
        Math.min(PLAYWRIGHT_ARTIFACT_FILE_MAX_BYTES, available)
      );
      await writeFile(path, redacted, { mode: 0o600 });
      retainedBytes += Buffer.byteLength(redacted);
    }
  };
  await visit(directory);
}

export async function collectHostedV1ScannerEvidence(
  sandbox: HostedV1Sandbox
): Promise<HostedV1ScannerEvidence> {
  const projects = await new ProjectScanner(
    join(sandbox.claudeDir, 'projects'),
    join(sandbox.claudeDir, 'todos')
  ).scan();
  return Object.freeze({
    expectedProjectFound: projects.some((project) => project.id === E2E_RUNTIME_WORKSPACE_ID),
    expectedRuntimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID,
    projectCount: projects.length,
    projects: Object.freeze(
      projects.map((project) =>
        Object.freeze({
          runtimeWorkspaceId: project.id,
          sessionCount: project.totalSessions,
        })
      )
    ),
  });
}

export function classifyHostedV1ProjectAccess(input: {
  readonly controllerProjectCount: number | null;
  readonly controllerProjectStatus: 'observed' | 'unavailable';
  readonly controllerExactExpectedProjectOnly: boolean;
  readonly fixturePrincipalGrantFound: boolean;
  readonly publicWorkspaceMapped: boolean;
  readonly registrationStatus: string | null;
  readonly scannerProjectFound: boolean;
}): ProjectAccessClassification {
  if (!input.scannerProjectFound) return 'scanner_empty';
  if (input.registrationStatus !== 'active') return 'registration_inactive';
  if (!input.publicWorkspaceMapped) return 'public_mapping_mismatch';
  if (!input.fixturePrincipalGrantFound) return 'grant_null';
  if (input.controllerProjectStatus === 'unavailable') return 'scanner_unavailable';
  return input.controllerProjectCount === 1 && input.controllerExactExpectedProjectOnly
    ? 'project_admitted'
    : 'scanner_empty';
}

async function readControllerProjectEvidence(
  observationFile: string
): Promise<HostedV1ControllerProjectEvidence> {
  try {
    const value = JSON.parse(await readFile(observationFile, 'utf8')) as {
      readonly exactExpectedPublicProject?: unknown;
      readonly projectCount?: unknown;
      readonly rawRuntimeIdentityAbsent?: unknown;
      readonly rawRuntimePathAbsent?: unknown;
      readonly status?: unknown;
    };
    if (
      value.status !== 'observed' ||
      !Number.isSafeInteger(value.projectCount) ||
      (value.projectCount as number) < 0 ||
      typeof value.exactExpectedPublicProject !== 'boolean' ||
      typeof value.rawRuntimeIdentityAbsent !== 'boolean' ||
      typeof value.rawRuntimePathAbsent !== 'boolean'
    ) {
      throw new Error('hosted_e2e_controller_project_observation_invalid');
    }
    return Object.freeze({
      status: 'observed',
      projectCount: value.projectCount as number,
      exactExpectedPublicProject: value.exactExpectedPublicProject,
      rawRuntimeIdentityAbsent: value.rawRuntimeIdentityAbsent,
      rawRuntimePathAbsent: value.rawRuntimePathAbsent,
    });
  } catch {
    return Object.freeze({
      status: 'unavailable',
      projectCount: null,
      exactExpectedPublicProject: false,
      rawRuntimeIdentityAbsent: false,
      rawRuntimePathAbsent: false,
    });
  }
}

export async function collectHostedV1GrantEvidence(input: {
  readonly appDataDir: string;
  readonly authMode: ScenarioMode;
  readonly controllerProjectObservationFile: string;
  readonly expectedOidcIssuer: string;
  readonly scannerEvidence: HostedV1ScannerEvidence;
}): Promise<HostedV1GrantEvidence> {
  const { default: Database } = await import('better-sqlite3-node');
  const database = new Database(join(input.appDataDir, 'data', 'storage', 'app.db'), {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const registration = database
      .prepare(
        `SELECT public_workspace_id AS publicWorkspaceId, status
         FROM hosted_workspaces WHERE runtime_workspace_id = ?`
      )
      .get(E2E_RUNTIME_WORKSPACE_ID) as
      | { readonly publicWorkspaceId: string; readonly status: string }
      | undefined;
    const principal = (
      input.authMode === 'personal'
        ? database.prepare(
            `SELECT principals.user_id AS userId,
                    CASE WHEN grants.user_id IS NULL THEN 0 ELSE 1 END AS grantFound
             FROM personal_owners AS principals
             INNER JOIN users ON users.user_id = principals.user_id AND users.status = 'active'
             LEFT JOIN hosted_workspace_grants AS grants
               ON grants.user_id = principals.user_id
              AND grants.runtime_workspace_id = ?
              AND grants.grant_generation = 0
             LIMIT 1`
          )
        : database.prepare(
            `SELECT principals.user_id AS userId,
                    CASE WHEN grants.user_id IS NULL THEN 0 ELSE 1 END AS grantFound
             FROM external_identities AS principals
             INNER JOIN users ON users.user_id = principals.user_id AND users.status = 'active'
             LEFT JOIN hosted_workspace_grants AS grants
               ON grants.user_id = principals.user_id
              AND grants.runtime_workspace_id = ?
              AND grants.grant_generation = 0
             WHERE principals.issuer = ?
               AND principals.provider_id = ?
               AND principals.subject = ?
             LIMIT 1`
          )
    ).get(
      E2E_RUNTIME_WORKSPACE_ID,
      ...(input.authMode === 'personal'
        ? []
        : [input.expectedOidcIssuer, 'synthetic-oidc', 'hosted-v1-e2e-owner'])
    ) as { readonly grantFound: 0 | 1; readonly userId: string } | undefined;
    const fixturePrincipalGrantFound = principal?.grantFound === 1;
    const expectedPublicWorkspaceMapped =
      registration?.publicWorkspaceId === E2E_PROJECT_WORKSPACE_ID;
    const controllerProjectEvidence = await readControllerProjectEvidence(
      input.controllerProjectObservationFile
    );
    return Object.freeze({
      schemaVersion: 1,
      storageLayout: 'app-data/data/storage/app.db',
      classification: classifyHostedV1ProjectAccess({
        scannerProjectFound: input.scannerEvidence.expectedProjectFound,
        controllerProjectCount: controllerProjectEvidence.projectCount,
        controllerProjectStatus: controllerProjectEvidence.status,
        controllerExactExpectedProjectOnly:
          controllerProjectEvidence.exactExpectedPublicProject &&
          controllerProjectEvidence.rawRuntimeIdentityAbsent &&
          controllerProjectEvidence.rawRuntimePathAbsent,
        registrationStatus: registration?.status ?? null,
        publicWorkspaceMapped: expectedPublicWorkspaceMapped,
        fixturePrincipalGrantFound,
      }),
      expectedRuntimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID,
      expectedPublicWorkspaceId: E2E_PROJECT_WORKSPACE_ID,
      registrationStatus: registration?.status ?? null,
      expectedPublicWorkspaceMapped,
      fixturePrincipalFound: principal !== undefined,
      fixturePrincipalGrantFound,
      controllerProjectEvidence,
    });
  } finally {
    database.close();
  }
}

async function writeEvidence(path: string, value: string): Promise<void> {
  let kind: 'json' | 'text' = 'text';
  try {
    JSON.parse(value);
    kind = 'json';
  } catch {
    // Preserve non-JSON logs as text; oversized values receive a typed JSON envelope.
  }
  const bounded = boundHostedV1EvidenceDocument(value, kind, HOSTED_V1_EVIDENCE_TEXT_MAX_BYTES - 1);
  await writeFile(path, bounded.endsWith('\n') ? bounded : `${bounded}\n`, { mode: 0o600 });
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('hosted_e2e_fixture_symlink_refused');
  await chown(path, uid, gid);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await chownTree(join(path, entry), uid, gid);
}

interface ArtifactOwner {
  readonly uid: number;
  readonly gid: number;
}

function invokingSudoOwner(): ArtifactOwner | null {
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  return uid && gid && /^\d+$/u.test(uid) && /^\d+$/u.test(gid)
    ? { uid: Number(uid), gid: Number(gid) }
    : null;
}

async function createEvidenceDirectory(
  sandbox: HostedV1Sandbox,
  artifactOwner: ArtifactOwner | null
): Promise<string> {
  const configured = process.env.HOSTED_E2E_ARTIFACT_DIR;
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be an absolute canonical directory');
  }
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const canonical = await realpath(configured);
  const stat = await lstat(configured);
  if (
    canonical !== configured ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be private and canonical');
  }
  const relation = relative(sandbox.root, canonical);
  if (
    !relation ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be outside the disposable sandbox');
  }
  const repositoryRelation = relative(repositoryRoot, canonical);
  if (
    !repositoryRelation ||
    (!repositoryRelation.startsWith(`..${sep}`) &&
      repositoryRelation !== '..' &&
      !isAbsolute(repositoryRelation))
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be outside the repository');
  }
  if (artifactOwner !== null) {
    // The root-run harness creates this private parent. Give the invoking runner ownership so the
    // post-sudo artifact uploader can traverse it; keep 0700 and marker-owned children unchanged.
    await chown(canonical, artifactOwner.uid, artifactOwner.gid);
    await chmod(canonical, 0o700);
  }
  const directory = join(canonical, `hosted-v1-${sandbox.marker}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function captureFailureEvidence(input: {
  readonly artifactDirectory: string;
  readonly artifactKey: string;
  readonly authMode: ScenarioMode;
  readonly composeArgs: readonly string[];
  readonly composeEnv: NodeJS.ProcessEnv;
  readonly caddyPublisherObservation: string | null;
  readonly controllerProjectObservationFile: string;
  readonly error: unknown;
  readonly expectedOidcIssuer: string;
  readonly pairingCode: string | null;
  readonly scannerEvidence: HostedV1ScannerEvidence;
  readonly sandbox: HostedV1Sandbox;
}): Promise<void> {
  const scenarioDirectory = join(input.artifactDirectory, input.artifactKey);
  await mkdir(scenarioDirectory, { recursive: true, mode: 0o700 });
  if (input.caddyPublisherObservation !== null) {
    await writeEvidence(
      join(scenarioDirectory, 'caddy-publisher-observation.json'),
      redactEvidence(input.caddyPublisherObservation, input.sandbox, input.pairingCode)
    );
  }
  await writeEvidence(
    join(scenarioDirectory, 'failure.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        authMode: input.authMode,
        status: 'failed',
        error: redactEvidence(safeError(input.error), input.sandbox, input.pairingCode),
      },
      null,
      2
    )
  );
  try {
    const appIp = input.composeEnv.E2E_APP_IP;
    if (typeof appIp !== 'string' || appIp.length === 0) {
      throw new Error('hosted_e2e_failed_http_probe_address_missing');
    }
    await writeEvidence(
      join(scenarioDirectory, 'controller-http-probe.json'),
      JSON.stringify(
        await captureHostedV1FailedRunHttpProbe({ origin: `http://${appIp}:3456` }),
        null,
        2
      )
    );
  } catch {
    await writeEvidence(
      join(scenarioDirectory, 'controller-http-probe.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          reachable: false,
          errorCode: 'probe_failed',
          httpStatus: null,
          readinessHeader: null,
        },
        null,
        2
      )
    );
  }
  await writeEvidence(
    join(scenarioDirectory, 'project-scanner.json'),
    JSON.stringify(input.scannerEvidence, null, 2)
  );
  try {
    await writeEvidence(
      join(scenarioDirectory, 'project-grant.json'),
      JSON.stringify(
        await collectHostedV1GrantEvidence({
          appDataDir:
            input.authMode === 'personal' ? input.sandbox.appDataDir : input.sandbox.oidcAppDataDir,
          authMode: input.authMode,
          scannerEvidence: input.scannerEvidence,
          controllerProjectObservationFile: input.controllerProjectObservationFile,
          expectedOidcIssuer: input.expectedOidcIssuer,
        }),
        null,
        2
      )
    );
  } catch (captureError) {
    await writeEvidence(
      join(scenarioDirectory, 'project-grant.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          storageLayout: 'app-data/data/storage/app.db',
          classification: 'grant_unavailable',
          error: redactEvidence(safeError(captureError), input.sandbox, input.pairingCode),
        },
        null,
        2
      )
    );
  }
  for (const [name, args] of [
    [
      'controller.log',
      [...input.composeArgs, 'logs', '--no-color', '--timestamps', 'hosted-controller'],
    ],
    ['compose.log', [...input.composeArgs, 'logs', '--no-color', '--timestamps']],
    ['compose-ps.json', [...input.composeArgs, 'ps', '--all', '--format', 'json']],
  ] as const) {
    try {
      const output = await run('docker', args, { env: input.composeEnv, capture: true });
      await writeEvidence(
        join(scenarioDirectory, name),
        redactEvidence(output, input.sandbox, input.pairingCode)
      );
    } catch (captureError) {
      await writeEvidence(
        join(scenarioDirectory, `${name}.error`),
        redactEvidence(safeError(captureError), input.sandbox, input.pairingCode)
      );
    }
  }
}

export function networkAddresses(marker: string): {
  readonly app: string;
  readonly caddy: string;
  readonly ingressSubnet: string;
  readonly oidc: string;
  readonly subnet: string;
} {
  const value = Number.parseInt(marker.slice(0, 4), 16);
  const prefix = `10.${64 + ((value >> 8) % 64)}.${value & 0xff}`;
  return Object.freeze({
    app: `${prefix}.3`,
    caddy: `${prefix}.2`,
    ingressSubnet: `${prefix}.16/28`,
    oidc: `${prefix}.4`,
    subnet: `${prefix}.0/28`,
  });
}

export function createHostedV1ExternalCoordinationReplayBudget(input: {
  readonly handoffBudgetMs: number;
  readonly heartbeatIntervalMs: number;
  readonly marginMs: number;
}): {
  readonly handoffBudgetMs: number;
  readonly heartbeatIntervalMs: number;
  readonly replayBudgetMs: number;
  deadlinesFrom(originMs: number): {
    readonly handoffDeadlineMs: number;
    readonly replayDeadlineMs: number;
  };
  requireRemainingAt(deadlineMs: number, observedAtMs: number): number;
} {
  const values = [input.handoffBudgetMs, input.heartbeatIntervalMs, input.marginMs];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('hosted_e2e_external_replay_budget_invalid');
  }
  const handoffBudgetMs = input.handoffBudgetMs;
  // The controller emits a heartbeat before replay.  A resumed reader must
  // therefore observe that heartbeat *and the following one* with a stable
  // durable cursor before replay is considered complete.
  const replayBudgetMs = (input.heartbeatIntervalMs * 2) + input.marginMs;
  return Object.freeze({
    handoffBudgetMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    replayBudgetMs,
    deadlinesFrom: (originMs: number) => {
      if (!Number.isFinite(originMs)) {
        throw new Error('hosted_e2e_external_replay_origin_invalid');
      }
      return Object.freeze({
        handoffDeadlineMs: originMs + handoffBudgetMs,
        replayDeadlineMs: originMs + handoffBudgetMs + replayBudgetMs,
      });
    },
    requireRemainingAt: (deadlineMs: number, observedAtMs: number) => {
      if (!Number.isFinite(deadlineMs) || !Number.isFinite(observedAtMs)) {
        throw new Error('hosted_e2e_external_replay_clock_invalid');
      }
      const remainingMs = Math.floor(deadlineMs - observedAtMs);
      if (remainingMs <= 0) {
        throw new Error('hosted_e2e_external_replay_deadline_exhausted');
      }
      return remainingMs;
    },
  });
}

/** Diagnostics are evidence-only: their failure must never replace proof failures. */
export async function runHostedV1BestEffortDiagnostic<T>(input: {
  readonly failures: string[];
  readonly name: string;
  /** The operation must honour this signal so a timeout reaps real work. */
  readonly operation: (signal: AbortSignal) => Promise<T>;
  /** Lets a scenario finalizer cancel diagnostics which are still in flight. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Publication workers must be killed and reaped before this callback returns. */
  readonly awaitAbortReap?: boolean;
}): Promise<T | null> {
  const timeoutMs = input.timeoutMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('hosted_e2e_diagnostic_timeout_invalid');
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('hosted_e2e_diagnostic_aborted'), { name: 'AbortError' });
    }
    // Invoke only inside the boundary.  Racing a timer alone leaves a live
    // attachment behind; timeout and scenario finalization abort the actual
    // operation and then reap it before this diagnostic is considered done.
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) {
        throw Object.assign(new Error('hosted_e2e_diagnostic_aborted'), { name: 'AbortError' });
      }
      return input.operation(controller.signal);
    });
    const settled = operation.then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('hosted_e2e_diagnostic_timeout'));
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });
    const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
    });
    const result = await Promise.race([settled, timeout, aborted]);
    if (result.kind === 'value') return result.value;
    if (result.kind === 'error') throw result.error;
    // A publication worker is deliberately different from an arbitrary
    // preparation callback: it is killable, so wait for its child reaper.
    // This prevents finalization from racing a renamed artifact.
    if (input.awaitAbortReap) await settled;
    if (result.kind === 'aborted' && !timedOut) {
      const abortError = new Error('hosted_e2e_diagnostic_aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    // A diagnostic is strictly best effort.  Never let a non-cooperative API
    // (for example a Playwright call which has already entered native code)
    // turn its one-second evidence budget into an unbounded wait.  The
    // controller makes cooperative work stop; consumers must use their own
    // admission guard before publishing a late result.
    const timeoutError = new Error('hosted_e2e_diagnostic_timeout');
    timeoutError.name = 'TimeoutError';
    throw timeoutError;
  } catch (error) {
    input.failures.push(
      error instanceof HostedV1ArtifactPersistenceError
        ? `${input.name}:${error.classification}:${error.path}`
        : `${input.name}:${error instanceof Error ? error.name : 'unknown_error'}`
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Evidence must not retain the mutable collector used while attachments are
 * still being attempted.  Callers can safely serialize this snapshot even as
 * later best-effort operations continue to add failures to their collector.
 */
export function freezeHostedV1DiagnosticFailures(
  failures: readonly string[]
): readonly string[] {
  return Object.freeze([...failures]);
}

/**
 * An evidence file is a publication, not a best-effort callback. The writer
 * lives in its own process so a hard deadline can actually stop an fsync or a
 * stalled filesystem. Its public destination is a durable commit record; the
 * payload remains a random transaction-private pathname until that record is
 * linked and its directory is synced.
 */
export class HostedV1ArtifactPersistenceError extends Error {
  readonly classification: 'aborted' | 'deadline_exceeded' | 'preparation_failed' | 'writer_failed';
  readonly path: string;

  constructor(
    classification: 'aborted' | 'deadline_exceeded' | 'preparation_failed' | 'writer_failed',
    path: string,
    options?: ErrorOptions
  ) {
    super(`hosted_e2e_artifact_persistence_${classification}:${path}`, options);
    this.name = 'HostedV1ArtifactPersistenceError';
    this.classification = classification;
    this.path = path;
  }
}

// Child stdout is a deliberately tiny newline-delimited protocol.  It must
// remain separate from stderr so the parent can make cleanup decisions from
// acknowledgements, not from a child exit code or arbitrary diagnostic text.
const hostedV1ArtifactProtocolPrefix = 'hosted-v1-artifact-v1:';
const hostedV1ArtifactProtocolRecords = {
  preparationFailed: 'preparation-failed',
  writerPreflight: 'writer-preflight',
  transactionPrepared: 'transaction-prepared',
  canonicalDirectorySynced: 'canonical-directory-synced',
  destinationOwned: 'destination-owned',
  cleanerAbsent: 'cleaner-absent',
  publicDestinationObserved: 'public-destination-observed',
  canonicalAbsent: 'canonical-absent',
  canonicalOwned: 'canonical-owned',
  canonicalCompeting: 'canonical-competing',
} as const;
type HostedV1ArtifactProtocolRecord =
  (typeof hostedV1ArtifactProtocolRecords)[keyof typeof hostedV1ArtifactProtocolRecords];

interface HostedV1ArtifactPreparedPayload {
  readonly byteLength: number;
  readonly sha256: string;
}

function parseHostedV1ArtifactProtocolRecords(input: {
  readonly buffer: string;
  readonly chunk: string;
}): {
  readonly buffer: string;
  readonly records: readonly HostedV1ArtifactProtocolRecord[];
  readonly payloads: readonly HostedV1ArtifactPreparedPayload[];
  readonly invalid: boolean;
} {
  const lines = `${input.buffer}${input.chunk}`.split('\n');
  const buffer = lines.pop() ?? '';
  let invalid = false;
  const records: HostedV1ArtifactProtocolRecord[] = [];
  const payloads: HostedV1ArtifactPreparedPayload[] = [];
  for (const line of lines) {
    if (!line.startsWith(hostedV1ArtifactProtocolPrefix)) {
      invalid = true;
      continue;
    }
    const record = line.slice(hostedV1ArtifactProtocolPrefix.length);
    const payload = /^payload-prepared:([0-9]+):([0-9a-f]{64})$/u.exec(record);
    if (payload) {
      const byteLength = Number(payload[1]);
      if (!Number.isSafeInteger(byteLength)) invalid = true;
      else payloads.push({ byteLength, sha256: payload[2] });
      continue;
    }
    if (
      record !== hostedV1ArtifactProtocolRecords.preparationFailed &&
      record !== hostedV1ArtifactProtocolRecords.writerPreflight &&
      record !== hostedV1ArtifactProtocolRecords.transactionPrepared &&
      record !== hostedV1ArtifactProtocolRecords.canonicalDirectorySynced &&
      record !== hostedV1ArtifactProtocolRecords.destinationOwned &&
      record !== hostedV1ArtifactProtocolRecords.cleanerAbsent &&
      record !== hostedV1ArtifactProtocolRecords.publicDestinationObserved &&
      record !== hostedV1ArtifactProtocolRecords.canonicalAbsent &&
      record !== hostedV1ArtifactProtocolRecords.canonicalOwned &&
      record !== hostedV1ArtifactProtocolRecords.canonicalCompeting
    ) {
      invalid = true;
      continue;
    }
    records.push(record);
  }
  return { buffer, records, payloads, invalid };
}

const hostedV1AtomicArtifactWriterProgram = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  // destination is the canonical commit record. temporary is an opaque,
  // transaction-private payload name and receipt is an opaque commit temp.
  // Neither private pathname is ever used as a public success signal.
  const [destination, temporary, receipt, capability, testPreparationStall, sourcePath, sourceRedactionJson, testInterruptAfterCanonicalLink, retentionBudgetJson, testRetentionProtocolJson] = process.argv.slice(1);
  const fail = (message) => { process.stderr.write(message); process.exitCode = 1; };
  const emit = (record) => process.stdout.write('hosted-v1-artifact-v1:' + record + '\n');
  let chunks = [];
  let body;
  const boundEvidenceUtf8 = (value, maximumBytes) => {
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.byteLength <= maximumBytes) return value;
    return new TextDecoder('utf-8').decode(encoded.subarray(0, maximumBytes), { stream: true });
  };
  const boundEvidenceDocument = (value, kind, maximumBytes) => {
    const fullRedactedBytes = Buffer.byteLength(value);
    if (fullRedactedBytes <= maximumBytes) return value;
    const fullRedactedSha256 = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    let preview = boundEvidenceUtf8(value, Math.max(0, Math.floor(maximumBytes / 2)));
    for (;;) {
      const envelope = JSON.stringify({ schemaVersion: 1, kind, fullRedactedBytes, fullRedactedSha256, truncated: true, preview });
      if (Buffer.byteLength(envelope) <= maximumBytes) return envelope;
      if (preview.length === 0) throw new Error('hosted_e2e_evidence_bound_too_small');
      preview = boundEvidenceUtf8(preview, Math.floor(Buffer.byteLength(preview) / 2));
    }
  };
  const retentionBudget = retentionBudgetJson ? JSON.parse(retentionBudgetJson) : null;
  const testRetentionProtocol = testRetentionProtocolJson ? JSON.parse(testRetentionProtocolJson) : null;
  // Test-only pause points are deliberately in the real writer process.  They
  // let the harness prove a filesystem interleaving without replacing any
  // production operation with a mock.
  const completedRetentionPauses = new Set();
  const pauseRetentionProtocol = (phase) => {
    const pause = testRetentionProtocol && testRetentionProtocol[phase];
    if (!pause || completedRetentionPauses.has(phase)) return;
    completedRetentionPauses.add(phase);
    fs.writeFileSync(pause.readyPath, '', { flag: 'wx', mode: 0o600 });
    while (!fs.existsSync(pause.resumePath)) waitForRetentionChange();
  };
  // lstat every extant component.  This is deliberately lexical: resolving
  // first would follow a symlink before we had a chance to reject it.
  const assertNoSymlinkPath = (target) => {
    const absolute = path.resolve(target);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error && error.code === 'ENOENT') return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
    }
  };
  const retainedCommittedPayloadBytes = (root) => {
    assertNoSymlinkPath(root);
    let retained = 0;
    const payloadIdentities = new Set();
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
        if (entry.isDirectory()) { visit(entryPath); continue; }
        if (!entry.isFile()) continue;
        let commit;
        try {
          assertNoSymlinkPath(entryPath);
          commit = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        } catch (error) {
          if (error && error.code === 'ENOENT') continue;
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (!commit || commit.schemaVersion !== 1 || commit.kind !== 'hosted-v1-artifact-commit' ||
            typeof commit.payload !== 'string' || !Number.isSafeInteger(commit.byteLength) ||
            typeof commit.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(commit.sha256) ||
            path.basename(commit.payload) !== commit.payload || !commit.payload.endsWith('.payload')) continue;
        let payload;
        const payloadPath = path.join(path.dirname(entryPath), commit.payload);
        try {
          assertNoSymlinkPath(payloadPath);
          payload = fs.readFileSync(payloadPath);
        }
        catch (error) {
          if (error && error.code === 'ENOENT') continue;
          throw error;
        }
        if (payload.byteLength !== commit.byteLength ||
            crypto.createHash('sha256').update(payload).digest('hex') !== commit.sha256) continue;
        // An interrupted publication leaves both its canonical link and
        // private receipt. They retain one payload, not two budgets. A valid
        // record which already exceeds policy is not corrupt evidence: it is
        // an admission failure and must propagate to every later writer.
        const identity = path.resolve(path.dirname(entryPath), commit.payload) + '\\0' +
          payload.byteLength + '\\0' + commit.sha256;
        if (!payloadIdentities.has(identity)) {
          if (payload.byteLength > retentionBudget.maximumFileBytes ||
              retained + payload.byteLength > retentionBudget.maximumTotalBytes) {
            throw new Error('hosted_e2e_playwright_committed_artifact_retention_budget_exceeded');
          }
          payloadIdentities.add(identity);
          retained += payload.byteLength;
        }
      }
    };
    try { visit(root); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return retained;
  };
  const availableRetentionBytes = () => {
    if (!retentionBudget) return null;
    const retained = retainedCommittedPayloadBytes(retentionBudget.root);
    return Math.max(0, Math.min(retentionBudget.maximumFileBytes, retentionBudget.maximumTotalBytes - retained));
  };
  const retentionLockPath = () => path.join(retentionBudget.root, '.hosted-v1-artifact-retention.lock');
  const retentionRecoveryPath = () => retentionLockPath() + '.recovery';
  // A pid alone is not a lease identity: it can name an unrelated process
  // after reuse.  Linux exposes the kernel start tick in /proc/<pid>/stat;
  // record and compare it for every protocol owner.  On platforms without an
  // equivalent exact identity, uncertainty is deliberately treated as live.
  // That can leave a stale foreign-platform claim for manual recovery, but it
  // can never let a reclaimer steal a live writer merely because its pid was
  // recycled.
  const processIncarnation = (pid) => {
    if (process.platform !== 'linux') return { kind: 'unknown' };
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
      const startTime = fields[19]; // field 22; fields begin at state (3).
      if (!/^\d+$/u.test(startTime || '')) return { kind: 'unknown' };
      return { kind: 'exact', value: 'linux-proc-start:' + startTime };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unknown' };
    }
  };
  const localIncarnation = processIncarnation(process.pid);
  const protocolOwner = (role, fields = {}) => ({
    ...fields,
    pid: process.pid,
    processIncarnation: localIncarnation.kind === 'exact' ? localIncarnation.value : null,
    retentionOwnerSchema: 'hosted-v1-retention-owner-v1',
    retentionOwnerRole: role,
  });
  const ownerIsLive = (owner) => {
    if (!Number.isSafeInteger(owner && owner.pid) || owner.pid < 1) return false;
    const observed = processIncarnation(owner.pid);
    if (observed.kind === 'missing') return false;
    // An absent or unobservable incarnation is never evidence that a process
    // is dead. This is intentionally stricter than kill(pid, 0).
    return observed.kind !== 'exact' ||
      typeof owner.processIncarnation !== 'string' ||
      observed.value === owner.processIncarnation;
  };
  const lockIdentity = (file) => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
    return stat.dev + ':' + stat.ino;
  };
  const readLockOwner = (file) => {
    assertNoSymlinkPath(file);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length < 1) {
      throw new Error('hosted_e2e_artifact_retention_lock_owner_invalid');
    }
    return owner;
  };
  const isProtocolOwner = (owner, role) =>
    owner && owner.retentionOwnerSchema === 'hosted-v1-retention-owner-v1' &&
    ['retention-lock', 'recovery-gate', 'publisher', 'reclaimer'].includes(role) &&
    owner.retentionOwnerRole === role &&
    typeof owner.token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(owner.token) &&
    (typeof owner.processIncarnation === 'string' || owner.processIncarnation === null);
  // A lock or recovery gate is published as a fully-written inode and linked
  // into its public name.  In particular, no contender can observe a newly
  // created, ownerless public gate between mkdir/open and its owner write.
  const publishOwnerFile = (target, owner) => {
    const candidate = target + '.candidate-' + crypto.randomUUID();
    const handle = fs.openSync(candidate, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(owner), 'utf8');
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    try {
      fs.linkSync(candidate, target);
      if (lockIdentity(candidate) !== lockIdentity(target)) {
        throw new Error('hosted_e2e_artifact_retention_owner_publish_cas_failed');
      }
      return lockIdentity(candidate);
    } finally { try { fs.unlinkSync(candidate); } catch (_) {} }
  };
  const waitForRetentionChange = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  // Claims live under a fixed-size, directory-local namespace.  In
  // particular, neither a long evidence filename nor a succession of dead
  // reclaimers can grow a basename past NAME_MAX.  The UUID is folded into a
  // digest so every attempted claimant gets a name that is never reused.
  const recoveryClaimPrefix = '.hosted-v1-reclaim-';
  const legacyOwnerlessMarker = (file, tokenPrefix) => {
    assertNoSymlinkPath(file);
    const stat = fs.lstatSync(file, { bigint: true });
    // The pre-atomic protocol could leave only its known, zero-byte marker
    // between open and owner publication. Do not turn an arbitrary regular
    // file (including a commit record) into recovery residue merely because
    // it is old and does not parse as a current owner.
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0n) return null;
    if (fs.readFileSync(file).byteLength !== 0) return null;
    const identity = stat.dev + ':' + stat.ino;
    return { identity, owner: { pid: 0, token: tokenPrefix + identity } };
  };
  const recoveryClaimGateKey = (gate) => crypto.createHash('sha256').update(gate).digest('hex');
  const recoveryClaimPath = (gate, role, identity, token) => path.join(
    path.dirname(gate),
    recoveryClaimPrefix + crypto.createHash('sha256')
      .update(recoveryClaimGateKey(gate) + '\0' + role + '\0' + identity + '\0' + token).digest('hex')
  );
  const recoveryClaimsForGate = (gate) => {
    const gateKey = recoveryClaimGateKey(gate);
    const claims = [];
    for (const entry of fs.readdirSync(path.dirname(gate), { withFileTypes: true })) {
      if (!entry.name.startsWith(recoveryClaimPrefix)) continue;
      if (entry.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      if (!entry.isFile()) continue;
      const claim = path.join(path.dirname(gate), entry.name);
      let owner;
      let claimIdentity;
      try { owner = readLockOwner(claim); claimIdentity = lockIdentity(claim); }
      catch (error) {
        if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
        continue;
      }
      if (owner.recoveryGateKey === gateKey && typeof owner.recoveryGateIdentity === 'string' &&
          (owner.recoveryGateRole === 'publisher' || owner.recoveryGateRole === 'reclaimer') &&
          isProtocolOwner(owner, owner.recoveryGateRole)) {
        const role = owner.recoveryGateRole;
        claims.push({ claim, owner, identity: claimIdentity, role });
      }
    }
    return claims;
  };
  const publisherClaimsForGate = (gate) =>
    recoveryClaimsForGate(gate).filter((claim) => claim.role === 'publisher');
  // Tombstones never share a namespace with user artifacts.  This makes
  // recovery a closed protocol directory rather than a substring search over
  // evidence filenames.
  const tombstoneDirectory = () => path.join(retentionBudget.root, '.hosted-v1-retention-tombstones');
  const ensureTombstoneDirectory = () => {
    const directory = tombstoneDirectory();
    try { fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); }
    catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
    }
    return directory;
  };
  const tombstoneName = (owner, identity) =>
    'v1-' + crypto.createHash('sha256').update(owner.token + '\0' + identity).digest('hex') + '.tombstone';
  const removalTombstonePath = (_file, owner, identity) => path.join(
    ensureTombstoneDirectory(), tombstoneName(owner, identity)
  );
  const isProtocolTombstoneName = (name) => /^v1-[0-9a-f]{64}\.tombstone$/u.test(name);
  const exactOwnerGeneration = (file, owner, identity) => {
    try { if (lockIdentity(file) !== identity) return false; }
    catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
    // Ownerless files are compatibility residue only when they exactly match
    // the old protocol's zero-byte marker. Their gate claim has already
    // excluded a replacement, but that does not authorize removing an
    // arbitrary nonempty artifact-like file at a reserved pathname.
    if (owner.pid === 0) {
      const prefix = owner.token.startsWith('legacy-ownerless-')
        ? 'legacy-ownerless-'
        : 'legacy-unpublished-';
      const legacy = legacyOwnerlessMarker(file, prefix);
      return legacy !== null && legacy.identity === identity && legacy.owner.token === owner.token;
    }
    try {
      const current = readLockOwner(file);
      return current.token === owner.token && current.pid === owner.pid &&
        current.processIncarnation === owner.processIncarnation;
    } catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
  };
  // A pathname cannot be unlinked conditionally on its inode.  The owner
  // protocol instead reserves the public name until this atomic promotion:
  // rename moves the inspected generation to its generation-specific
  // tombstone, making a later replacement visible at the public name rather
  // than deleting it.  A crash after rename leaves only that inert tombstone.
  const promoteExactOwnerFile = (file, owner, identity) => {
    if (!exactOwnerGeneration(file, owner, identity)) return null;
    const tombstone = removalTombstonePath(file, owner, identity);
    try { fs.lstatSync(tombstone); return null; }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    try { fs.renameSync(file, tombstone); }
    catch (error) { if (error && (error.code === 'ENOENT' || error.code === 'EEXIST')) return null; throw error; }
    // Another cleaner may have discarded this now-private inode.  Its
    // disappearance/replacement is a failed CAS, never a writer failure.
    return exactOwnerGeneration(tombstone, owner, identity) ? tombstone : null;
  };
  const discardPromotedOwnerFile = (tombstone, identity) => {
    try {
      if (lockIdentity(tombstone) !== identity) return false;
      fs.unlinkSync(tombstone);
      return true;
    } catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
  };
  const recoverAbandonedTombstones = () => {
    // Promotion can survive a kill between rename and discard. Tombstone
    // names are generation-specific and are never publication targets, so a
    // dead tombstone can be retired without touching any successor's public
    // pathname. A live promoter is left alone.
    let directory;
    try {
      directory = tombstoneDirectory();
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      }
    }
    catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!isProtocolTombstoneName(entry.name)) continue;
      const tombstone = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      if (!entry.isFile()) continue;
      let owner;
      let identity;
      try { owner = readLockOwner(tombstone); identity = lockIdentity(tombstone); }
      catch (error) {
        if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
        // The private namespace may contain debris from an interrupted older
        // version. It is not a protocol claim unless its complete schema is
        // readable, so leave it untouched and let a later valid writer retry.
        continue;
      }
      if (!isProtocolOwner(owner, owner.retentionOwnerRole) ||
          entry.name !== tombstoneName(owner, identity) || ownerIsLive(owner)) continue;
      if (!exactOwnerGeneration(tombstone, owner, identity)) continue;
      discardPromotedOwnerFile(tombstone, identity);
    }
  };
  const releaseOwnerFile = (claim, token, identity) => {
    try {
      const owner = readLockOwner(claim);
      if (owner.token !== token || owner.pid !== process.pid ||
          owner.processIncarnation !== (localIncarnation.kind === 'exact' ? localIncarnation.value : null) ||
          lockIdentity(claim) !== identity) return false;
      const tombstone = promoteExactOwnerFile(claim, owner, identity);
      return tombstone !== null && discardPromotedOwnerFile(tombstone, identity);
    } catch (error) {
      // A concurrent recovery/replacement wins this generation. Releasing a
      // private claim is best-effort and must not abort an otherwise valid
      // publisher after its artifact has already been committed.
      if (error && error.code === 'ENOENT') return false;
      if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
      return false;
    }
  };
  const recoverAbandonedRecoveryClaim = (claim) => {
    let owner;
    let identity;
    try { owner = readLockOwner(claim); identity = lockIdentity(claim); }
    catch (error) {
      if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
      return Boolean(error && error.code === 'ENOENT');
    }
    // A claim is a lease held by its exact published owner. Never take it
    // from a live process; a dead claimant has no remaining operation to
    // serialize, so remove only the generation we just re-read.
    if (ownerIsLive(owner)) return false;
    try {
      const current = readLockOwner(claim);
      if (current.token !== owner.token || current.pid !== owner.pid ||
          current.processIncarnation !== owner.processIncarnation || lockIdentity(claim) !== identity ||
          ownerIsLive(current)) return false;
      const tombstone = promoteExactOwnerFile(claim, owner, identity);
      return tombstone !== null && discardPromotedOwnerFile(tombstone, identity);
    } catch (error) { return Boolean(error && error.code === 'ENOENT'); }
  };
  const reclaimDeadClaims = (claims) => {
    for (const claim of claims) {
      if (ownerIsLive(claim.owner)) return false;
      if (!recoverAbandonedRecoveryClaim(claim.claim)) return false;
    }
    return true;
  };
  // A public gate can be retired only by a reclaimer claim, and it can be
  // created only while a publisher claim is live.  These are one shared
  // barrier protocol, not independent validate-then-rename checks:
  //
  // * a publisher advertises before its final no-gate observation;
  // * a reclaimer advertises before its final old-generation observation;
  // * either side which sees the other backs out and retries.
  //
  // Consequently, a reclaimer that could still rename the public name always
  // has a visible claim while a replacement is being considered.  Conversely,
  // a publisher which can create a replacement prevents any later reclaimer
  // from reaching promotion.  The link operation remains create-only; neither operation
  // uses a replacing rename at the public pathname.
  const publishAfterReclaimerBarrier = (gate, publish) => {
    const token = crypto.randomUUID();
    const claim = recoveryClaimPath(gate, 'publisher', 'publication', token);
    let identity;
    try {
      identity = publishOwnerFile(claim, protocolOwner('publisher', {
        token,
        recoveryGateKey: recoveryClaimGateKey(gate),
        recoveryGateIdentity: 'publication',
        recoveryGateRole: 'publisher',
      }));
      pauseRetentionProtocol('afterPublisherClaim');
      // A publisher that died before linking a public inode leaves only this
      // private, fixed-size claim. Clear exact dead generations here as well
      // as during reclamation so crash recovery cannot accumulate barriers.
      if (!reclaimDeadClaims(publisherClaimsForGate(gate).filter((entry) => entry.claim !== claim))) return null;
      const reclaimers = recoveryClaimsForGate(gate).filter((entry) => entry.role === 'reclaimer');
      if (!reclaimDeadClaims(reclaimers)) {
        pauseRetentionProtocol('afterPublisherReclaimerBarrierEncountered');
        return null;
      }
      // A second scan closes the cleanup-to-publication seam. A reclaimer
      // which appears after this scan sees our publisher claim before it can
      // promote, so it cannot touch the generation created by publish.
      if (recoveryClaimsForGate(gate).some((entry) => entry.role === 'reclaimer')) {
        pauseRetentionProtocol('afterPublisherReclaimerBarrierEncountered');
        return null;
      }
      return publish();
    } finally {
      if (identity !== undefined) releaseOwnerFile(claim, token, identity);
    }
  };
  const recoverAbandonedRecoveryGate = () => {
    const gate = retentionRecoveryPath();
    let owner;
    let identity;
    try { owner = readLockOwner(gate); identity = lockIdentity(gate); }
    catch (error) {
      if (error && error.code === 'ENOENT') return true;
      if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
      // Only the old protocol's exact zero-byte marker can reach here.
      // Current publication is owner-bearing and atomic, so ageing that
      // narrow compatibility residue cannot steal a live current setup.
      try {
        const stat = fs.lstatSync(gate);
        if (stat.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
        if (Date.now() - stat.mtimeMs <= 250) return false;
        const legacy = legacyOwnerlessMarker(gate, 'legacy-ownerless-');
        if (legacy === null) return false;
        ({ identity, owner } = legacy);
      } catch (error) {
        if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
        return false;
      }
    }
    if (ownerIsLive(owner)) return false;
    // The reclaimer claim is published before the final exact-generation
    // observation. Publishers use the complementary claim above, so they
    // cannot replace this pathname until this claim is gone.
    const claimToken = crypto.randomUUID();
    const claim = recoveryClaimPath(gate, 'reclaimer', identity, claimToken);
    let claimIdentity;
    try {
      try {
        claimIdentity = publishOwnerFile(claim, protocolOwner('reclaimer', {
          token: claimToken,
          recoveryGateKey: recoveryClaimGateKey(gate),
          recoveryGateIdentity: identity,
          recoveryGateRole: 'reclaimer',
        }));
      }
      catch (error) { if (error && error.code !== 'EEXIST') throw error; return false; }
      pauseRetentionProtocol('afterReclaimerClaim');
      // A publisher which arrived before this check must finish (or crash and
      // be recovered) before this reclaimer can rename the public gate.
      if (!reclaimDeadClaims(publisherClaimsForGate(gate))) return false;
      if (publisherClaimsForGate(gate).length > 0) return false;
      let current;
      let currentIdentity;
      try { current = readLockOwner(gate); currentIdentity = lockIdentity(gate); }
      catch (_) {
        const legacy = legacyOwnerlessMarker(gate, 'legacy-ownerless-');
        if (legacy === null) return false;
        current = legacy.owner;
        currentIdentity = legacy.identity;
      }
      if (current.token !== owner.token || current.pid !== owner.pid ||
          current.processIncarnation !== owner.processIncarnation ||
          currentIdentity !== identity || ownerIsLive(current)) return false;
      const tombstone = promoteExactOwnerFile(gate, owner, identity);
      if (tombstone !== null) pauseRetentionProtocol('afterRecoveryGateRetired');
      return tombstone !== null && discardPromotedOwnerFile(tombstone, identity);
    } catch (error) {
      if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
      return Boolean(error && error.code === 'ENOENT');
    }
    finally {
      if (claimIdentity !== undefined) {
        pauseRetentionProtocol('beforeReclaimerClaimReleased');
        releaseOwnerFile(claim, claimToken, claimIdentity);
        pauseRetentionProtocol('afterReclaimerClaimReleased');
      }
    }
  };
  const recoverRetentionLock = (lock) => {
    const gate = retentionRecoveryPath();
    const token = crypto.randomUUID();
    let owner;
    let identity;
    try { owner = readLockOwner(lock); identity = lockIdentity(lock); }
    catch (error) {
      if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
      // A legacy zero-byte lock marker must age before recovery. Atomic file
      // publication below never creates this state, so a live writer can
      // never be mistaken for this compatibility case.
      try {
        const stat = fs.lstatSync(lock);
        if (stat.isSymbolicLink()) throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
        // Do not reclaim a directory with no owner. That is exactly the old
        // mkdir-to-owner publication gap; treating it as stale can delete a
        // writer that has already acquired the directory but not published.
        if (Date.now() - stat.mtimeMs <= 250) return false;
        const legacy = legacyOwnerlessMarker(lock, 'legacy-unpublished-');
        if (legacy === null) return false;
        ({ identity } = legacy);
        owner = legacy.owner;
      }
      catch (error) {
        if (error instanceof Error && error.message === 'hosted_e2e_playwright_artifact_symlink_forbidden') throw error;
        return false;
      }
    }
    if (owner.pid > 0 && ownerIsLive(owner)) return false;
    let gateIdentity;
    try {
      gateIdentity = publishAfterReclaimerBarrier(gate, () =>
        publishOwnerFile(gate, protocolOwner('recovery-gate', { token }))
      );
      if (gateIdentity === null) return false;
      pauseRetentionProtocol('afterRecoveryGatePublished');
    } catch (error) {
      if (error && error.code === 'EEXIST') return false;
      throw error;
    }
    try {
      // The gate serializes recovery with every compliant acquirer. Re-read
      // the immutable owner after claiming it; never unlink a generation we
      // did not inspect and prove dead.
      let current;
      let currentIdentity;
      try { current = readLockOwner(lock); currentIdentity = lockIdentity(lock); }
      catch (_) {
        const legacy = legacyOwnerlessMarker(lock, 'legacy-unpublished-');
        if (legacy === null) return false;
        current = legacy.owner;
        currentIdentity = legacy.identity;
      }
      if (current.token !== owner.token || current.pid !== owner.pid ||
          current.processIncarnation !== owner.processIncarnation ||
          currentIdentity !== identity ||
          (current.pid > 0 && ownerIsLive(current))) return false;
      const tombstone = promoteExactOwnerFile(lock, owner, identity);
      return tombstone !== null && discardPromotedOwnerFile(tombstone, identity);
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      throw error;
    } finally { if (gateIdentity !== undefined) releaseOwnerFile(gate, token, gateIdentity); }
  };
  const acquireRetentionLock = () => {
    if (!retentionBudget) return null;
    const lock = retentionLockPath();
    const token = crypto.randomUUID();
    const deadline = Date.now() + 2_000;
    for (;;) {
        if (Date.now() >= deadline) throw new Error('hosted_e2e_artifact_retention_lock_timeout');
        recoverAbandonedTombstones();
        try {
          fs.lstatSync(retentionRecoveryPath());
          if (!recoverAbandonedRecoveryGate()) waitForRetentionChange();
          continue;
        }
        catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        try {
          // The lock publication participates in the same recovery-gate
          // barrier. The gate may be created concurrently, but its owner will
          // then re-read this immutable, live lock and cannot retire it.
          const identity = publishAfterReclaimerBarrier(retentionRecoveryPath(), () =>
            publishOwnerFile(lock, protocolOwner('retention-lock', { token }))
          );
          if (identity === null) {
            waitForRetentionChange();
            continue;
          }
          pauseRetentionProtocol('afterLockPublished');
          return { lock, token, identity };
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
        if (!recoverRetentionLock(lock)) waitForRetentionChange();
      }
  };
  const releaseRetentionLock = (lock) => {
    if (lock === null) return;
    releaseOwnerFile(lock.lock, lock.token, lock.identity);
  };
  const boundToRetention = (value, kind, maximumBytes) => {
    try { return boundEvidenceDocument(value, kind, maximumBytes); }
    catch (error) {
      if (error instanceof Error && error.message === 'hosted_e2e_evidence_bound_too_small') return '';
      throw error;
    }
  };
  const boundCommittedBody = (value, maximumBytes) => {
    if (maximumBytes === null || Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
    if (maximumBytes === 0) return '';
    try { JSON.parse(value); return boundToRetention(value, 'json', maximumBytes); }
    catch (_) { return boundToRetention(value, 'text', maximumBytes); }
  };
  const sanitizeSourceBody = (value, maximumBytes = null) => {
    if (!sourceRedactionJson) return value;
    const config = JSON.parse(sourceRedactionJson);
    if (!config || !Array.isArray(config.replacements) ||
        !Number.isSafeInteger(config.maximumBytes) || config.maximumBytes < 1) {
      throw new Error('source_redaction_invalid');
    }
    const boundedMaximumBytes = maximumBytes === null
      ? config.maximumBytes
      : Math.min(config.maximumBytes, maximumBytes);
    if (boundedMaximumBytes === 0) return '';
    const placeholderForKey = (key) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized === 'authorization' || normalized === 'proxyauthorization') return '<authorization>';
      if (normalized === 'xagentteamscsrf' || normalized === 'xcsrftoken' || normalized === 'csrf' || normalized.includes('csrftoken')) return '<csrf-token>';
      if (normalized === 'cookie' || normalized === 'setcookie') return '<cookie>';
      if (normalized === 'code' || normalized === 'state') return '<oidc-value>';
      if (normalized.includes('trustanchor')) return '<trust-anchor>';
      if (normalized.includes('password') || normalized.includes('passwd') || normalized.includes('passphrase')) return '<password>';
      if (normalized.includes('secret') || normalized.includes('credential') || normalized.includes('privatekey')) return '<secret>';
      if (normalized.includes('token') || normalized.includes('apikey')) return '<token>';
      return null;
    };
    const redactText = (text) => {
      for (const replacement of config.replacements) {
        if (!replacement || typeof replacement.value !== 'string' || typeof replacement.placeholder !== 'string') {
          throw new Error('source_redaction_replacement_invalid');
        }
        text = text.replaceAll(replacement.value, replacement.placeholder);
      }
      return text
        .replace(/(^|[\r\n]\s*)((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gimu, '$1$2<cookie>')
        .replace(/(__Host-agent-teams-[A-Za-z0-9_-]+["':=\s]+)[^;,\s"']+/gu, '$1<cookie>')
        .replace(/([?&](?:code|state)=)[^&\s"']+/giu, '$1<oidc-value>')
        .replace(/([?&](?:api[_-]?key|[^&=]*(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^&=]*)=)[^&\s"'#]*/giu, '$1<sensitive-value>')
        .replace(/(["']?(?:code|state)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{16,}/giu, '$1<oidc-value>')
        .replace(/((?:x-agent-teams-csrf|csrf[_-]?token|csrfToken)["':=\s]+)[A-Za-z0-9_-]{32,}/giu, '$1<csrf-token>')
        .replace(/((?:authorization|proxy[_-]?authorization)["':=\s]+)(?:bearer\s+)?[^\r\n,;]+/giu, '$1<authorization>')
        .replace(/((?:^|\s)--?(?:api[_-]?key|[^\s]{0,128}(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^\s]{0,128})\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gimu, '$1<sensitive-value>')
        .replace(/((["']?)([^\s"':=,;]{1,256})\2\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu, (match, prefix) => {
          const key = /["']?([^\s"':=]+)["']?\s*[:=]\s*$/u.exec(prefix)?.[1] || '';
          const placeholder = placeholderForKey(key);
          return placeholder === null ? match : prefix + placeholder;
        })
        .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '<jwt>');
    };
    const redactJson = (input, key = '') => {
      const placeholder = placeholderForKey(key);
      if (placeholder !== null) {
        if (typeof input === 'string') return placeholder;
        if (Array.isArray(input)) return input.map(() => placeholder);
        if (input !== null) return placeholder;
      }
      if (typeof input === 'string') return redactText(input);
      if (Array.isArray(input)) return input.map((item) => redactJson(item));
      if (typeof input === 'object' && input !== null) {
        return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redactJson(item, key)]));
      }
      return input;
    };
    let redacted;
    let kind;
    try {
      redacted = JSON.stringify(redactJson(JSON.parse(value)));
      kind = 'json';
    } catch (_) {
      redacted = redactText(value);
      kind = 'text';
    }
    return boundToRetention(redacted, kind, boundedMaximumBytes);
  };
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('error', (error) => fail(error && error.name || 'stdin_error'));
  process.stdin.on('end', () => {
    let canonicalLinked = false;
    try {
      // Directory creation is part of the transaction, not a Playwright-side
      // convenience.  mkdir can block just like fsync, so it must run in this
      // killable writer under the persistence deadline.
      try {
        // Harness-only seam for proving a stalled preparation cannot hang the
        // parent. Production never supplies this argument.
        if (testPreparationStall === 'stall') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        }
        const outputDirectory = path.dirname(destination);
        assertNoSymlinkPath(outputDirectory);
        assertNoSymlinkPath(destination);
        assertNoSymlinkPath(temporary);
        assertNoSymlinkPath(receipt);
        if (retentionBudget !== null) assertNoSymlinkPath(retentionBudget.root);
        fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
        const outputDirectoryStat = fs.lstatSync(outputDirectory);
        if (outputDirectoryStat.isSymbolicLink() || !outputDirectoryStat.isDirectory()) {
          throw new Error('artifact_output_directory_not_directory');
        }
        // Re-check destination and all transaction aliases after mkdir, before
        // any retry validation or retention accounting can read them.
        assertNoSymlinkPath(destination);
        assertNoSymlinkPath(temporary);
        assertNoSymlinkPath(receipt);
        if (retentionBudget !== null) assertNoSymlinkPath(retentionBudget.root);
        // A path-backed Playwright attachment is also preparation. Reading it
        // here keeps even an unhealthy evidence source out of the parent.
        body = sourcePath ? fs.readFileSync(sourcePath) : Buffer.concat(chunks);
        // First derive a stable per-file candidate. Its identity is checked
        // against a committed retry before aggregate capacity is consulted.
        const maximumBytes = retentionBudget === null ? null : retentionBudget.maximumFileBytes;
        if (sourcePath && sourceRedactionJson) {
          body = Buffer.from(
            sanitizeSourceBody(new TextDecoder('utf-8', { fatal: true }).decode(body), maximumBytes),
            'utf8'
          );
        } else if (maximumBytes !== null) {
          body = Buffer.from(
            boundCommittedBody(new TextDecoder('utf-8', { fatal: true }).decode(body), maximumBytes),
            'utf8'
          );
        }
      } catch (error) {
        emit('preparation-failed');
        fail('preparation_failed:' + (error instanceof Error ? error.message : 'preparation_error'));
        return;
      }
      const expectedPayload = path.basename(temporary);
      const candidateBody = body;
      const committedBodyForCandidate = (commitPath, expectedBody) => {
        assertNoSymlinkPath(commitPath);
        const expectedByteLength = expectedBody.byteLength;
        const expectedSha256 = crypto.createHash('sha256').update(expectedBody).digest('hex');
        let commit;
        try { commit = JSON.parse(fs.readFileSync(commitPath, 'utf8')); } catch (_) { return null; }
        if (!commit || commit.schemaVersion !== 1 || commit.kind !== 'hosted-v1-artifact-commit' ||
            typeof commit.payload !== 'string' || !Number.isSafeInteger(commit.byteLength) ||
            typeof commit.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(commit.sha256) ||
            path.basename(commit.payload) !== commit.payload) return null;
        const destinationName = path.basename(commitPath);
        const artifactNameId = Buffer.byteLength(destinationName, 'utf8') <= 180
          ? destinationName
          : 'id-' + crypto.createHash('sha256').update(destinationName, 'utf8').digest('hex');
        const expectedPrefix = '.' + artifactNameId + '.';
        if (!commit.payload.startsWith(expectedPrefix) ||
            commit.payload.length !== expectedPrefix.length + 64 + '.payload'.length ||
            !/^[0-9a-f]{64}$/.test(commit.payload.slice(expectedPrefix.length, -'.payload'.length)) ||
            !commit.payload.endsWith('.payload')) return null;
        let payload;
        const payloadPath = path.join(path.dirname(commitPath), commit.payload);
        try {
          assertNoSymlinkPath(payloadPath);
          payload = fs.readFileSync(payloadPath);
        } catch (error) {
          if (error && error.code === 'ENOENT') return null;
          throw error;
        }
        if (payload.byteLength !== commit.byteLength ||
            crypto.createHash('sha256').update(payload).digest('hex') !== commit.sha256) return null;
        // Aggregate admission may have truncated this candidate. Persisting
        // the pre-aggregate candidate identity lets a retry prove it is the
        // same request before today's unrelated admissions are considered.
        // Older commit records did not carry that identity, so retain their
        // conservative exact-payload comparison rather than widening retry.
        const candidateMatches =
          Number.isSafeInteger(commit.candidateByteLength) &&
          typeof commit.candidateSha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(commit.candidateSha256)
            ? commit.candidateByteLength === expectedByteLength && commit.candidateSha256 === expectedSha256
            : commit.byteLength === expectedByteLength && commit.sha256 === expectedSha256;
        if (!candidateMatches) return null;
        // Candidate metadata identifies the request, but is not itself a
        // binding to retained bytes. Require new records to prove that their
        // payload is the deterministic bounded representation of that exact
        // candidate. Thus changing both payload and candidate metadata cannot
        // turn B into a retry of A within this commit-file trust boundary.
        if (Object.hasOwn(commit, 'candidateByteLength') || Object.hasOwn(commit, 'candidateSha256')) {
          if (!Number.isSafeInteger(commit.retainedMaximumBytes) || commit.retainedMaximumBytes < 0) return null;
          let expectedPayload;
          try {
            expectedPayload = Buffer.from(
              boundCommittedBody(new TextDecoder('utf-8', { fatal: true }).decode(expectedBody), commit.retainedMaximumBytes),
              'utf8'
            );
          } catch (_) { return null; }
          if (!payload.equals(expectedPayload)) return null;
        }
        return payload;
      };
      const confirmExistingDestination = () => {
        fs.lstatSync(destination);
        // Keep the strict retained-artifact audit: a retry may bypass only
        // fresh capacity selection, never validation of the other committed
        // evidence already under this budget.
        if (retentionBudget !== null) retainedCommittedPayloadBytes(retentionBudget.root);
        const committedBody = committedBodyForCandidate(destination, candidateBody);
        if (committedBody === null) throw new Error('destination_exists');
        emit('payload-prepared:' + committedBody.byteLength + ':' +
          crypto.createHash('sha256').update(committedBody).digest('hex'));
        emit('writer-preflight');
        emit('transaction-prepared');
        const retryDirectory = fs.openSync(path.dirname(destination), 'r');
        try { fs.fsyncSync(retryDirectory); } finally { fs.closeSync(retryDirectory); }
        emit('canonical-directory-synced');
        emit('destination-owned');
      };
      // A previous writer can die after linking the canonical commit and
      // before acknowledgement. Check that immutable record before taking
      // aggregate capacity; a full budget cannot reject the same-body retry.
      try {
        confirmExistingDestination();
        return;
      } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      // The lock covers retained-byte observation through commit publication.
      // Two production writers therefore cannot reserve the same remaining
      // aggregate bytes. Recheck destination after acquiring it: another
      // writer may have committed the same body between the optimistic read
      // above and this serialized admission point.
      const retentionLock = acquireRetentionLock();
      try {
        try {
          confirmExistingDestination();
          return;
        } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        // Even without a retention policy, record the exact deterministic
        // bound which leaves an inline candidate unchanged.
        let retainedMaximumBytes = candidateBody.byteLength;
        if (retentionBudget !== null) {
          const maximumBytes = availableRetentionBytes();
          retainedMaximumBytes = maximumBytes;
          body = Buffer.from(
            boundCommittedBody(new TextDecoder('utf-8', { fatal: true }).decode(candidateBody), maximumBytes),
            'utf8'
          );
        }
      const bodyByteLength = body.byteLength;
      const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
      emit('payload-prepared:' + bodyByteLength + ':' + bodySha256);
      try { fs.lstatSync(receipt); throw new Error('receipt_exists'); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      // The parent may classify the destination as published only after this
      // acknowledgement. It is emitted before the first transaction-private
      // pathname is created and remains buffered through child close.
      emit('writer-preflight');
      // The payload is deliberately not the canonical destination. A crash
      // after this point can leave an opaque private payload, but cannot leave
      // a public artifact that resembles committed evidence or blocks retry.
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, body);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      const publicationDirectory = fs.openSync(path.dirname(destination), 'r');
      try { fs.fsyncSync(publicationDirectory); } finally { fs.closeSync(publicationDirectory); }
      // This acknowledges only private payload durability. It is intentionally
      // before canonical visibility so a SIGKILL at this seam is retry-safe.
      emit('transaction-prepared');
      const commit = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        kind: 'hosted-v1-artifact-commit',
        payload: expectedPayload,
        byteLength: bodyByteLength,
        sha256: bodySha256,
        candidateByteLength: candidateBody.byteLength,
        candidateSha256: crypto.createHash('sha256').update(candidateBody).digest('hex'),
        retainedMaximumBytes,
      }), 'utf8');
      const commitHandle = fs.openSync(receipt, 'wx', 0o600);
      try {
        fs.writeFileSync(commitHandle, commit);
        fs.fsyncSync(commitHandle);
      } finally {
        fs.closeSync(commitHandle);
      }
      // link() is no-replace publication. A competing canonical commit is
      // never overwritten, and failure cleanup below only touches our random
      // private names.
      fs.linkSync(receipt, destination);
      canonicalLinked = true;
      // Harness-only seam: prove the parent never cleans a payload after its
      // canonical commit record has become visible but before acknowledgement.
      if (testInterruptAfterCanonicalLink === 'interrupt-after-canonical-link') {
        process.kill(process.pid, 'SIGKILL');
      }
      const directory = fs.openSync(path.dirname(destination), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      emit('canonical-directory-synced');
      fs.unlinkSync(receipt);
      const finalDirectory = fs.openSync(path.dirname(destination), 'r');
      try { fs.fsyncSync(finalDirectory); } finally { fs.closeSync(finalDirectory); }
      // This acknowledgement follows the durable commit record. Consumers
      // must validate that record and its digest instead of accepting a raw
      // pathname as evidence.
      emit('destination-owned');
      } finally {
        releaseRetentionLock(retentionLock);
      }
    } catch (error) {
      // After link succeeds the canonical record refers to the private payload by
      // name. Never delete either private name here: a retry/settler must
      // validate the linked record first. Before that point both are merely
      // uncommitted transaction-private staging and can be cleaned safely.
      if (!canonicalLinked) {
        try { fs.unlinkSync(temporary); } catch (_) {}
        try { fs.unlinkSync(receipt); } catch (_) {}
      }
      fail(error instanceof Error ? error.message : 'writer_error');
    }
  });
`;

// Cleanup runs in a killable child too.  A promise race cannot stop a stalled
// parent-process filesystem call, while this child remains bounded by the same
// absolute persistence deadline as the writer.
const hostedV1AtomicArtifactCleanupProgram = String.raw`
  try {
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const crypto = require('node:crypto');
    const [destination, receipt, capability, scope, testInterruptAfterEncounter, expectedByteLength, expectedSha256] = process.argv.slice(1);
    if (typeof capability !== 'string' || capability.length < 1) throw new Error('transaction_capability_invalid');
    if (scope === 'private') {
      // The randomized temporary name is transaction-private.  It is the
      // only pathname cleanup may unlink; the receipt remains as durable
      // evidence for a retained public destination.
      try { fs.unlinkSync(destination); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      try { fs.lstatSync(destination); throw new Error('private_path_still_present'); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      process.stdout.write('hosted-v1-artifact-v1:cleaner-absent\n');
    } else if (scope === 'public') {
      // This is observation-only recovery. It deliberately has no unlink,
      // rename, or quarantine path: a public record is never cleanup-owned.
      let publicPresent = true;
      try {
        fs.lstatSync(destination, { bigint: true });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          publicPresent = false;
        } else {
          throw error;
        }
      }
      if (!publicPresent) {
        process.stdout.write('hosted-v1-artifact-v1:canonical-absent\n');
      } else {
        // The emitted observation is a real parent-visible seam. The focused
        // crash test kills this child in its write callback, immediately after
        // the public directory entry has been observed and before validation.
        process.stdout.write('hosted-v1-artifact-v1:public-destination-observed\n', () => {
          if (testInterruptAfterEncounter === 'interrupt-after-encounter') process.kill(process.pid, 'SIGKILL');
          try {
            const commit = JSON.parse(fs.readFileSync(destination, 'utf8'));
            const payload = typeof commit.payload === 'string' ? commit.payload : '';
            const bytes = fs.readFileSync(nodePath.join(nodePath.dirname(destination), payload));
            const expectedLength = Number(expectedByteLength);
            const valid = commit && commit.schemaVersion === 1 && commit.kind === 'hosted-v1-artifact-commit' &&
              Number.isSafeInteger(commit.byteLength) && typeof commit.sha256 === 'string' &&
              /^[0-9a-f]{64}$/.test(commit.sha256) && nodePath.basename(payload) === payload &&
              payload.endsWith('.payload') && bytes.byteLength === commit.byteLength &&
              crypto.createHash('sha256').update(bytes).digest('hex') === commit.sha256;
            process.stdout.write('hosted-v1-artifact-v1:' +
              (valid && commit.byteLength === expectedLength && commit.sha256 === expectedSha256
                ? 'canonical-owned' : 'canonical-competing') + '\n');
          } catch (_) {
            process.stdout.write('hosted-v1-artifact-v1:canonical-competing\n');
          }
        });
      }
    } else {
      throw new Error('cleanup_scope_invalid');
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'cleanup_error');
    process.exitCode = 1;
  }
`;

export async function writeHostedV1AtomicArtifact(input: {
  readonly path: string;
  /** Inline evidence. Exactly one of body and sourcePath must be provided. */
  readonly body?: string;
  /** An absolute path read by the supervised writer, never by the test process. */
  readonly sourcePath?: string;
  /**
   * Converts raw evidence to the final redacted bytes before the supervised
   * writer sees it. The returned string is the only payload that is hashed.
   */
  readonly sanitizeBody?: (body: string) => string;
  /**
   * Declarative redaction for path-backed diagnostics. It deliberately avoids
   * serializing a closure into the child process while still ensuring the
   * worker redacts and bounds bytes before it computes its commit digest.
   */
  readonly sourceRedaction?: {
    readonly replacements: readonly { readonly value: string; readonly placeholder: string }[];
    readonly maximumBytes: number;
  };
  /**
   * Immutable Playwright attachments are admitted under these payload budgets
   * by the writer before their digest-bearing commit record is published.
   */
  readonly retentionBudget?: {
    readonly root: string;
    readonly maximumFileBytes: number;
    readonly maximumTotalBytes: number;
  };
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Harness-only seam for a stalled preparation inside the supervised writer. */
  readonly testPreparationStall?: boolean;
  /** Focused harness proof only; kills the real writer after canonical link. */
  readonly testWriterInterruptAfterCanonicalLink?: boolean;
  /** Focused harness proof only; production callers always use the real writer. */
  readonly testWriterProgram?: string;
  /** Focused harness proof only; production callers always use the real cleaner. */
  readonly testCleanupProgram?: string;
  /** Focused harness proof only; kills cleanup immediately after public-path observation. */
  readonly testCleanupInterruptAfterEncounter?: boolean;
  /** Focused harness proof only; called after the real observation protocol record arrives. */
  readonly testOnPublicDestinationObserved?: () => void;
  /** Focused harness proof only; called after the real canonical-directory fsync. */
  readonly testOnCanonicalDirectorySynced?: () => void;
  /**
   * Focused harness proof only. Each pause is a real writer-process protocol
   * seam: it creates readyPath and waits until resumePath exists.
   */
  readonly testRetentionProtocol?: Partial<Record<
    | 'afterReclaimerClaim'
    | 'afterRecoveryGateRetired'
    | 'beforeReclaimerClaimReleased'
    | 'afterReclaimerClaimReleased'
    | 'afterPublisherClaim'
    | 'afterPublisherReclaimerBarrierEncountered'
    | 'afterRecoveryGatePublished'
    | 'afterLockPublished',
    { readonly readyPath: string; readonly resumePath: string }
  >>;
}): Promise<void> {
  const hasInlineBody = typeof input.body === 'string';
  const hasSourcePath = typeof input.sourcePath === 'string';
  if (
    !isAbsolute(input.path) ||
    hasInlineBody === hasSourcePath ||
    (hasSourcePath && !isAbsolute(input.sourcePath ?? '')) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1
  ) {
    throw new Error('hosted_e2e_artifact_writer_input_invalid');
  }
  if (
    input.retentionBudget !== undefined &&
    (!isAbsolute(input.retentionBudget.root) ||
      relative(input.retentionBudget.root, input.path).startsWith(`..${sep}`) ||
      relative(input.retentionBudget.root, input.path) === '..' ||
      !Number.isSafeInteger(input.retentionBudget.maximumFileBytes) ||
      input.retentionBudget.maximumFileBytes < 1 ||
      !Number.isSafeInteger(input.retentionBudget.maximumTotalBytes) ||
      input.retentionBudget.maximumTotalBytes < 1)
  ) {
    throw new Error('hosted_e2e_artifact_writer_retention_budget_invalid');
  }
  if (input.retentionBudget !== undefined) {
    const destination = relative(input.retentionBudget.root, input.path);
    const [firstSegment = ''] = destination.split(sep);
    const lockName = '.hosted-v1-artifact-retention.lock';
    // These names are not artifact namespaces. They are protocol-owned
    // public gates, create-only candidates, claims, and private tombstones.
    // Reject them before a writer process is spawned, so artifact publication
    // can never overwrite, pin, or later reclaim protocol state.
    if (
      firstSegment === '.recovery' ||
      firstSegment === lockName ||
      firstSegment.startsWith(`${lockName}.`) ||
      firstSegment.startsWith('.hosted-v1-reclaim-') ||
      firstSegment === '.hosted-v1-retention-tombstones'
    ) {
      throw new Error('hosted_e2e_artifact_writer_retention_destination_reserved');
    }
  }
  if (hasSourcePath && input.sanitizeBody !== undefined) {
    throw new Error('hosted_e2e_artifact_writer_source_sanitizer_invalid');
  }
  if (
    input.sourceRedaction !== undefined &&
    (!Number.isSafeInteger(input.sourceRedaction.maximumBytes) || input.sourceRedaction.maximumBytes < 1)
  ) {
    throw new Error('hosted_e2e_artifact_writer_source_redaction_invalid');
  }
  if (
    input.testRetentionProtocol !== undefined &&
    Object.values(input.testRetentionProtocol).some((pause) =>
      pause === undefined || !isAbsolute(pause.readyPath) || !isAbsolute(pause.resumePath)
    )
  ) {
    throw new Error('hosted_e2e_artifact_writer_retention_protocol_invalid');
  }
  const inlineBody = input.body ?? '';
  const committedBody = input.sanitizeBody === undefined ? inlineBody : input.sanitizeBody(inlineBody);
  if (typeof committedBody !== 'string') throw new Error('hosted_e2e_artifact_writer_sanitizer_invalid');
  let committedByteLength = Buffer.byteLength(committedBody, 'utf8');
  let committedSha256 = createHash('sha256').update(committedBody, 'utf8').digest('hex');
  let classification: HostedV1ArtifactPersistenceError['classification'] | null = null;
  let succeeded = false;
  let writer: ReturnType<typeof spawn> | undefined;
  let writerClosed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined;
  let destinationOwned = false;
  let transactionPrepared = false;
  let preparationFailed = false;
  let primaryFailure: unknown;
  let cleanupFailure: HostedV1ArtifactPersistenceError | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let operationStop: ((error: HostedV1ArtifactPersistenceError) => void) | undefined;
  const operationStopped = new Promise<HostedV1ArtifactPersistenceError>((resolve) => { operationStop = resolve; });
  const deadlineAtMs = Date.now() + input.timeoutMs;
  // Reserve the tail of the one absolute deadline for reaping the owned child
  // and names. The parent does no filesystem work: it only supervises one
  // killable child at a time.
  const cleanupReserveMs = Math.max(1, Math.min(250, Math.floor(input.timeoutMs / 4)));
  const operationBudgetMs = Math.max(1, input.timeoutMs - cleanupReserveMs);
  const stopWriter = (reason: HostedV1ArtifactPersistenceError['classification']) => {
    classification ??= reason;
    writer?.kill('SIGKILL');
    operationStop?.(new HostedV1ArtifactPersistenceError(classification, input.path));
  };
  operationTimer = setTimeout(() => {
    stopWriter('deadline_exceeded');
  }, operationBudgetMs);
  const abort = () => {
    stopWriter('aborted');
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  const withinOperationBudget = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([
      operation,
      operationStopped.then((error) => Promise.reject(error)),
    ]);
  const cleanupFailures: unknown[] = [];
  const artifactNameId = Buffer.byteLength(basename(input.path), 'utf8') <= 180
    ? basename(input.path)
    : `id-${createHash('sha256').update(basename(input.path), 'utf8').digest('hex')}`;
  const privateNameDigest = () => createHash('sha256').update(randomUUID()).digest('hex');
  const capability = randomUUID();
  const temporary = join(dirname(input.path), `.${artifactNameId}.${privateNameDigest()}.payload`);
  // This is a transaction-private staging file for the canonical commit
  // record, not an ownership receipt for the public destination.
  const receipt = join(dirname(input.path), `.${artifactNameId}.${privateNameDigest()}.receipt`);
  const cleanupOwnedPath = async (
    path: string,
    scope: 'private' | 'public'
  ): Promise<'canonical-absent' | 'canonical-owned' | 'canonical-competing' | null> => {
    let cleaner: ReturnType<typeof spawn>;
    try {
      cleaner = spawn(process.execPath, [
        '-e', input.testCleanupProgram ?? hostedV1AtomicArtifactCleanupProgram,
        path,
        receipt,
        capability,
        scope,
        input.testCleanupInterruptAfterEncounter && scope === 'public' ? 'interrupt-after-encounter' : '',
        String(committedByteLength),
        committedSha256,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanupFailures.push(error);
      return null;
    }
    let protocolBuffer = '';
    let protocolInvalid = false;
    let cleanerAbsent = false;
    let publicDestinationObserved = false;
    let canonicalSettlement: 'canonical-absent' | 'canonical-owned' | 'canonical-competing' | null = null;
    let stderr = '';
    cleaner.stdout?.setEncoding('utf8');
    cleaner.stderr?.setEncoding('utf8');
    cleaner.stdout?.on('data', (chunk: string) => {
      const parsed = parseHostedV1ArtifactProtocolRecords({ buffer: protocolBuffer, chunk });
      protocolBuffer = parsed.buffer;
      protocolInvalid ||= parsed.invalid;
      for (const record of parsed.records) {
        if (record === hostedV1ArtifactProtocolRecords.cleanerAbsent && !cleanerAbsent) {
          cleanerAbsent = true;
        } else if (
          record === hostedV1ArtifactProtocolRecords.publicDestinationObserved &&
          scope === 'public' &&
          !publicDestinationObserved
        ) {
          publicDestinationObserved = true;
          input.testOnPublicDestinationObserved?.();
        } else if (
          (record === hostedV1ArtifactProtocolRecords.canonicalAbsent ||
            record === hostedV1ArtifactProtocolRecords.canonicalOwned ||
            record === hostedV1ArtifactProtocolRecords.canonicalCompeting) &&
          scope === 'public' &&
          canonicalSettlement === null
        ) {
          canonicalSettlement = record;
        } else {
          protocolInvalid = true;
        }
      }
    });
    cleaner.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const cleaned = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly spawnError: unknown;
    }>((resolve) => {
      cleaner.once('error', (spawnError) => resolve({ code: null, signal: null, spawnError }));
      cleaner.once('close', (code, signal) => resolve({ code, signal, spawnError: null }));
    });
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      try {
        if (!cleaner.kill('SIGKILL')) cleanupFailures.push(new Error(`cleanup_kill_refused:${path}`));
      } catch (error) {
        cleanupFailures.push(error);
      }
      // Do not return while a cleaner is live, even when the work budget has
      // already been exhausted.  This is a deliberately separate hard reap
      // reserve, not a promise race that abandons the child.
      const reapReserveMs = Math.max(1, Math.min(100, Math.floor(input.timeoutMs / 4)));
      const reaped = await Promise.race([
        cleaned,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), reapReserveMs)),
      ]);
      if (reaped === null) cleanupFailures.push(new Error(`cleanup_reap_deadline_exceeded:${path}`));
      else if (reaped.spawnError !== null || reaped.signal !== 'SIGKILL') {
        cleanupFailures.push(new Error(`cleanup_reap_unconfirmed:${path}`));
      }
      cleanupFailures.push(new Error(`cleanup_deadline_exhausted:${path}`));
      return null;
    }
    const reapReserveMs = Math.max(1, Math.min(100, Math.floor(remainingMs / 2)));
    const workBudgetMs = Math.max(1, remainingMs - reapReserveMs);
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        cleaned,
        new Promise<null>((resolve) => { workTimer = setTimeout(() => resolve(null), workBudgetMs); }),
      ]);
      if (result === null) {
        const signalFailures: unknown[] = [];
        try {
          if (!cleaner.kill('SIGKILL')) signalFailures.push(new Error(`cleanup_kill_refused:${path}`));
        } catch (error) {
          signalFailures.push(error);
        }
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        const reaped = await Promise.race([
          cleaned,
          new Promise<null>((resolve) => { reapTimer = setTimeout(() => resolve(null), reapReserveMs); }),
        ]);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        if (reaped === null) signalFailures.push(new Error(`cleanup_reap_deadline_exceeded:${path}`));
        else if (reaped.spawnError !== null || reaped.signal !== 'SIGKILL') {
          signalFailures.push(new Error(`cleanup_reap_unconfirmed:${path}`));
        }
        cleanupFailures.push(
          new AggregateError(
            [new Error(`cleanup_deadline_exceeded:${path}`), ...signalFailures],
            'hosted_e2e_artifact_cleaner_timeout_failures'
          )
        );
        return null;
      }
      const privateConfirmed = scope === 'private' && cleanerAbsent;
      const publicConfirmed =
        scope === 'public' &&
        ((canonicalSettlement === 'canonical-absent' && !publicDestinationObserved) ||
          (canonicalSettlement !== 'canonical-absent' && publicDestinationObserved));
      if (
        result.code !== 0 ||
        result.signal !== null ||
        result.spawnError !== null ||
        !(privateConfirmed || publicConfirmed) ||
        protocolInvalid ||
        protocolBuffer !== ''
      ) {
        cleanupFailures.push(new Error(
          `cleanup_unconfirmed:${path}:${stderr}:${JSON.stringify({
            cleanerAbsent,
            publicDestinationObserved,
            canonicalSettlement,
            protocolInvalid,
            protocolBuffer,
            code: result.code,
            signal: result.signal,
          })}`
        ));
        return null;
      }
      return canonicalSettlement;
    } catch (error) {
      cleanupFailures.push(error);
      return null;
    } finally {
      if (workTimer !== undefined) clearTimeout(workTimer);
    }
  };
  try {
    const activeWriter = spawn(process.execPath, [
      '-e', input.testWriterProgram ?? hostedV1AtomicArtifactWriterProgram,
      input.path,
      temporary,
      receipt,
      capability,
      input.testPreparationStall ? 'stall' : '',
      input.sourcePath ?? '',
      input.sourceRedaction === undefined ? '' : JSON.stringify(input.sourceRedaction),
      input.testWriterInterruptAfterCanonicalLink ? 'interrupt-after-canonical-link' : '',
      input.retentionBudget === undefined ? '' : JSON.stringify(input.retentionBudget),
      input.testRetentionProtocol === undefined ? '' : JSON.stringify(input.testRetentionProtocol),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    writer = activeWriter;
    let protocolBuffer = '';
    let protocolInvalid = false;
    let writerPreflightConfirmed = false;
    let canonicalDirectorySynced = false;
    let preparedPayload: HostedV1ArtifactPreparedPayload | undefined;
    let writerStderr = '';
    activeWriter.stdout?.setEncoding('utf8');
    activeWriter.stderr?.setEncoding('utf8');
    activeWriter.stderr?.on('data', (chunk: string) => { writerStderr += chunk; });
    activeWriter.stdout?.on('data', (chunk: string) => {
      const parsed = parseHostedV1ArtifactProtocolRecords({ buffer: protocolBuffer, chunk });
      protocolBuffer = parsed.buffer;
      protocolInvalid ||= parsed.invalid;
      for (const payload of parsed.payloads) {
        if (preparedPayload !== undefined) {
          protocolInvalid = true;
        } else {
          preparedPayload = payload;
          committedByteLength = payload.byteLength;
          committedSha256 = payload.sha256;
        }
      }
      for (const record of parsed.records) {
        if (
          record === hostedV1ArtifactProtocolRecords.preparationFailed &&
          !preparationFailed &&
          preparedPayload === undefined &&
          !writerPreflightConfirmed &&
          !transactionPrepared &&
          !destinationOwned
        ) {
          preparationFailed = true;
        } else if (record === hostedV1ArtifactProtocolRecords.writerPreflight && !writerPreflightConfirmed && !destinationOwned) {
          writerPreflightConfirmed = true;
        } else if (
          record === hostedV1ArtifactProtocolRecords.transactionPrepared &&
          writerPreflightConfirmed &&
          !transactionPrepared &&
          !destinationOwned
        ) {
          transactionPrepared = true;
        } else if (
          record === hostedV1ArtifactProtocolRecords.canonicalDirectorySynced &&
          writerPreflightConfirmed &&
          transactionPrepared &&
          !destinationOwned &&
          !canonicalDirectorySynced
        ) {
          canonicalDirectorySynced = true;
          input.testOnCanonicalDirectorySynced?.();
        } else if (
          record === hostedV1ArtifactProtocolRecords.destinationOwned &&
          writerPreflightConfirmed &&
          transactionPrepared &&
          !destinationOwned
        ) {
          destinationOwned = true;
        } else {
          protocolInvalid = true;
        }
      }
    });
    writerClosed = new Promise((resolve) => {
      activeWriter.once('error', () => resolve({ code: null, signal: null }));
      activeWriter.once('close', (code, signal) => resolve({ code, signal }));
    });
    // spawn() is synchronous but an abort may be delivered between it and the
    // stdin write.  Do not hand the writer bytes after that boundary.
    if (classification !== null) throw new HostedV1ArtifactPersistenceError(classification, input.path);
    await withinOperationBudget(new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const writerFailures = new AggregateError([], 'hosted_e2e_artifact_writer_failures');
      const recordWriterFailure = (error: unknown): void => {
        writerFailures.errors.push(error);
      };
      const rejectWriter = (error: HostedV1ArtifactPersistenceError): void => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      const writerSucceeded = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      // This must be registered before end() so EPIPE from a writer that
      // exits during its input handoff is owned by this bounded operation.
      // Keep the listener through child close: SIGKILL teardown can surface a
      // later stdin error, and removing it would turn that into an uncaught
      // stream error.
      // Do not settle from stdin/process errors. A preparation failure can
      // close either stream before its protocol and stderr drain; close is the
      // single terminal classification point for this child.
      activeWriter.stdin?.on('error', recordWriterFailure);
      activeWriter.once('error', recordWriterFailure);
      activeWriter.once('close', (code, signal) => {
        if (classification !== null) {
          rejectWriter(new HostedV1ArtifactPersistenceError(classification, input.path));
        } else if (preparationFailed || writerStderr.startsWith('preparation_failed:')) {
          rejectWriter(new HostedV1ArtifactPersistenceError('preparation_failed', input.path, {
            cause: writerFailures,
          }));
        } else if (
          code === 0 &&
          signal === null &&
          (!hasSourcePath || preparedPayload !== undefined) &&
          writerPreflightConfirmed &&
          transactionPrepared &&
          destinationOwned &&
          !protocolInvalid &&
          protocolBuffer === ''
        ) {
          writerSucceeded();
        } else {
          const error = new HostedV1ArtifactPersistenceError('writer_failed', input.path, {
            cause: writerFailures,
          });
          recordWriterFailure(error);
          rejectWriter(error);
        }
      });
      try {
        if (activeWriter.stdin === null || activeWriter.stdin === undefined) {
          recordWriterFailure(new Error('hosted_e2e_artifact_writer_stdin_unavailable'));
        } else {
          activeWriter.stdin.end(committedBody, 'utf8');
        }
      } catch (error) {
        recordWriterFailure(error);
      }
    }));
    succeeded = true;
  } catch (error) {
    primaryFailure = error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
    if (operationTimer !== undefined) clearTimeout(operationTimer);
    operationTimer = undefined;
    if (!succeeded && writer !== undefined) {
      // Entering cleanup permanently disconnects the writer timer before a
      // cleaner is assigned. Old operation timers therefore cannot kill a
      // cleaner; each cleanup child receives its own deadline-derived timer.
      writer.kill('SIGKILL');
      if (writerClosed !== undefined) {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) cleanupFailures.push(new Error('writer_reap_deadline_exhausted'));
        else {
          let reapTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              writerClosed,
              new Promise<never>((_resolve, reject) => {
                reapTimer = setTimeout(
                  () => reject(new Error('writer_reap_deadline_exceeded')),
                  remainingMs
                );
              }),
            ]);
          } catch (error) {
            cleanupFailures.push(error);
          } finally {
            if (reapTimer !== undefined) clearTimeout(reapTimer);
          }
        }
      }
      // Canonical evidence is a commit record and is never a cleanup target.
      // Once a transaction-prepared writer has failed, first settle through a
      // killable, observation-only reader. It decides whether `temporary` is
      // still uncommitted private staging or the payload referenced by the
      // already-linked canonical record. In the latter case it must survive.
      let canonicalSettlement: 'canonical-absent' | 'canonical-owned' | 'canonical-competing' | null = null;
      if (!preparationFailed && !destinationOwned) {
        canonicalSettlement = await cleanupOwnedPath(input.path, 'public');
      }
      if (!preparationFailed) {
        if (canonicalSettlement !== 'canonical-owned' && canonicalSettlement !== null) {
          await cleanupOwnedPath(temporary, 'private');
        } else if (!transactionPrepared) {
          await cleanupOwnedPath(temporary, 'private');
        }
      }
    }
    if (cleanupFailures.length > 0) {
      classification ??= 'writer_failed';
      cleanupFailure = new HostedV1ArtifactPersistenceError(classification, input.path, {
        cause: new AggregateError(
          primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
          'hosted_e2e_artifact_cleanup_failures'
        ),
      });
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (primaryFailure !== undefined) throw primaryFailure;
}

/**
 * Reads evidence only through its durable commit record. A raw payload file,
 * including one left by a killed writer before commit, is never accepted.
 */
export async function readHostedV1CommittedArtifact(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('hosted_e2e_artifact_commit_path_invalid');
  let rawCommit: string;
  try {
    rawCommit = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`hosted_e2e_artifact_commit_missing:${path}`, { cause: error });
  }
  let commit: unknown;
  try {
    commit = JSON.parse(rawCommit);
  } catch (error) {
    throw new Error(`hosted_e2e_artifact_commit_invalid:${path}`, { cause: error });
  }
  if (
    commit === null ||
    typeof commit !== 'object' ||
    (commit as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (commit as { kind?: unknown }).kind !== 'hosted-v1-artifact-commit' ||
    typeof (commit as { payload?: unknown }).payload !== 'string' ||
    !Number.isSafeInteger((commit as { byteLength?: unknown }).byteLength) ||
    (commit as { byteLength: number }).byteLength < 0 ||
    typeof (commit as { sha256?: unknown }).sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test((commit as { sha256: string }).sha256)
  ) {
    throw new Error(`hosted_e2e_artifact_commit_invalid:${path}`);
  }
  const payloadName = (commit as { payload: string }).payload;
  const destinationName = basename(path);
  const artifactNameId = Buffer.byteLength(destinationName, 'utf8') <= 180
    ? destinationName
    : `id-${createHash('sha256').update(destinationName, 'utf8').digest('hex')}`;
  const expectedPrefix = `.${artifactNameId}.`;
  if (
    !payloadName.startsWith(expectedPrefix) ||
    payloadName.length !== expectedPrefix.length + 64 + '.payload'.length ||
    !/^[0-9a-f]{64}$/u.test(payloadName.slice(expectedPrefix.length, -'.payload'.length)) ||
    !payloadName.endsWith('.payload') ||
    basename(payloadName) !== payloadName
  ) {
    throw new Error(`hosted_e2e_artifact_commit_payload_invalid:${path}`);
  }
  const payloadPath = join(dirname(path), payloadName);
  let payload: Buffer;
  try {
    payload = await readFile(payloadPath);
  } catch (error) {
    throw new Error(`hosted_e2e_artifact_commit_payload_missing:${path}`, { cause: error });
  }
  const byteLength = (commit as { byteLength: number }).byteLength;
  const sha256 = (commit as { sha256: string }).sha256;
  if (
    payload.byteLength !== byteLength ||
    createHash('sha256').update(payload).digest('hex') !== sha256
  ) {
    throw new Error(`hosted_e2e_artifact_commit_payload_mismatch:${path}`);
  }
  return payload.toString('utf8');
}

export interface HostedV1ExternalCoordinationObservedEvent {
  readonly eventId: string | null;
  readonly eventSequence: number | null;
  readonly frameIndex: number;
  readonly streamId: number;
  /** Wall-clock receipt time, retained for the resumed-stream completion proof. */
  readonly observedAtMs: number;
}

/** The serializable portion of the browser's resumed-stream observation. */
export interface HostedV1ExternalCoordinationReconnectState {
  readonly error: string | null;
  readonly events: readonly HostedV1ExternalCoordinationObservedEvent[];
  readonly heartbeatCursors: readonly string[];
  readonly heartbeatEventCounts: readonly number[];
  readonly heartbeatFrameIndexes: readonly number[];
  readonly heartbeatObservedAtMs: readonly number[];
  readonly heartbeatStreamIds: readonly number[];
  readonly opens: number;
  readonly reconnects: number;
}

export interface HostedV1ExternalCoordinationReconnectBaseline {
  readonly cursor: string;
  readonly reconnects: number;
  readonly streamGeneration: number;
}

export interface HostedV1ExternalCoordinationReconnectProofCapture {
  /** A browser-to-Node-safe copy of the exact state which passed the poll. */
  readonly serializedState: string;
  /** Receipt time of the second resumed heartbeat in that exact copy. */
  readonly observedAtMs: number;
}

/** The largest browser-state receipt eligible for reconnect proof capture. */
export const HOSTED_V1_EXTERNAL_COORDINATION_RECONNECT_PROOF_MAX_BYTES = 64 * 1024;

/**
 * The production poll adapter. It deliberately owns the capture-to-assertion
 * operation so callers cannot turn a successful poll into a later browser
 * reread or a later wall-clock assertion.
 */
export async function pollHostedV1ExternalCoordinationReconnectProof(input: {
  readonly baseline: HostedV1ExternalCoordinationReconnectBaseline;
  readonly originMs: number;
  readonly poll: (
    predicate: () => Promise<HostedV1ExternalCoordinationReconnectProofCapture | null>,
    timeoutMs: number
  ) => Promise<void>;
  readonly replayDeadlineMs: number;
  readonly stateReader: () => Promise<HostedV1ExternalCoordinationReconnectState | null>;
  readonly targetEventId: string;
  readonly targetEventSequence: number;
  readonly timeoutMs: number;
}): Promise<HostedV1ExternalCoordinationReconnectProofCapture> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error('hosted_e2e_external_reconnect_poll_timeout_invalid');
  }
  let capture: HostedV1ExternalCoordinationReconnectProofCapture | null = null;
  await input.poll(async () => {
    // This is the sole browser-state read for each poll predicate invocation.
    const state = await input.stateReader();
    const candidate = captureAndAssertHostedV1ExternalCoordinationReconnectProof({
      baseline: input.baseline,
      stateReader: () => state,
      originMs: input.originMs,
      replayDeadlineMs: input.replayDeadlineMs,
      targetEventId: input.targetEventId,
      targetEventSequence: input.targetEventSequence,
    });
    if (candidate !== null) capture = candidate;
    return candidate;
  }, input.timeoutMs);
  if (capture === null) throw new Error('hosted_e2e_external_reconnect_stream_missing');
  return capture;
}

/**
 * Reads the browser state once and returns the exact serialized state which
 * crossed the replay-completion boundary.  The caller must validate this
 * result rather than rereading browser state after polling, because a later
 * transport transition can invalidate an already completed proof.
 */
export function captureHostedV1ExternalCoordinationReconnectProof(input: {
  readonly baseline: HostedV1ExternalCoordinationReconnectBaseline;
  readonly stateReader: () => HostedV1ExternalCoordinationReconnectState | null;
}): HostedV1ExternalCoordinationReconnectProofCapture | null {
  const state = input.stateReader();
  if (state === null) return null;
  const serializedState = JSON.stringify(state);
  if (
    Buffer.byteLength(serializedState, 'utf8') >
    HOSTED_V1_EXTERNAL_COORDINATION_RECONNECT_PROOF_MAX_BYTES
  ) {
    throw new Error('hosted_e2e_external_reconnect_state_too_large');
  }
  const candidate = JSON.parse(serializedState) as HostedV1ExternalCoordinationReconnectState;
  if (
    candidate.opens !== input.baseline.streamGeneration + 1 ||
    candidate.reconnects <= input.baseline.reconnects ||
    candidate.error !== null
  ) {
    return null;
  }
  const resumedHeartbeatIndexes = candidate.heartbeatStreamIds.flatMap((streamId, index) =>
    streamId === input.baseline.streamGeneration + 1 ? [index] : []
  );
  const replayStartHeartbeatIndex = resumedHeartbeatIndexes[0];
  const completionHeartbeatIndex = resumedHeartbeatIndexes[1];
  const observedAtMs =
    completionHeartbeatIndex === undefined
      ? Number.NaN
      : candidate.heartbeatObservedAtMs[completionHeartbeatIndex] ?? Number.NaN;
  if (
    replayStartHeartbeatIndex === undefined ||
    completionHeartbeatIndex === undefined ||
    !Number.isFinite(candidate.heartbeatObservedAtMs[replayStartHeartbeatIndex]) ||
    !Number.isFinite(observedAtMs) ||
    candidate.heartbeatCursors[replayStartHeartbeatIndex] !== input.baseline.cursor ||
    candidate.heartbeatCursors[completionHeartbeatIndex] !== input.baseline.cursor ||
    !Number.isSafeInteger(candidate.heartbeatEventCounts[replayStartHeartbeatIndex]) ||
    !Number.isSafeInteger(candidate.heartbeatEventCounts[completionHeartbeatIndex])
  ) {
    return null;
  }
  return Object.freeze({ serializedState, observedAtMs });
}

export function assertHostedV1ExternalCoordinationStreamProof(input: {
  /**
   * Event identities observed before crossing the launch boundary. The target
   * must not already be among them, but unrelated coordination activity is
   * valid and must not invalidate this exact-target delivery proof.
   */
  readonly launchBoundaryEventIds: readonly (string | null)[];
  readonly launchBoundaryFrameIndex: number;
  readonly opens: number;
  readonly reconnects: number;
  readonly error: string | null;
  readonly heartbeatStreamIds: readonly number[];
  readonly heartbeatFrameIndexes: readonly number[];
  readonly events: readonly HostedV1ExternalCoordinationObservedEvent[];
  readonly targetEventId: string;
}): void {
  if (input.launchBoundaryEventIds.includes(input.targetEventId)) {
    throw new Error('hosted_e2e_external_coordination_target_before_boundary');
  }
  if (input.opens !== 1 || input.reconnects !== 0 || input.error !== null) {
    throw new Error('hosted_e2e_external_coordination_stream_identity_unstable');
  }
  const targets = input.events.filter((event) => event.eventId === input.targetEventId);
  if (targets.length !== 1) throw new Error('hosted_e2e_external_coordination_target_not_exactly_once');
  const target = targets[0];
  if (!target) throw new Error('hosted_e2e_external_coordination_target_not_exactly_once');
  if (target.frameIndex < input.launchBoundaryFrameIndex) {
    throw new Error('hosted_e2e_external_coordination_target_before_boundary');
  }
  if (
    input.heartbeatStreamIds.length === 0 ||
    !input.heartbeatStreamIds.every((streamId) => streamId === 1) ||
    !input.heartbeatFrameIndexes.some((frameIndex) => frameIndex < target.frameIndex)
  ) {
    throw new Error('hosted_e2e_external_coordination_heartbeat_before_target_missing');
  }
  if (!input.events.every((event) => event.streamId === 1)) {
    throw new Error('hosted_e2e_external_coordination_event_stream_identity_unstable');
  }
  let previousSequence = -1;
  for (const event of input.events) {
    if (
      typeof event.eventSequence !== 'number' ||
      !Number.isSafeInteger(event.eventSequence) ||
      event.eventSequence <= previousSequence
    ) {
      throw new Error('hosted_e2e_external_coordination_sequence_not_monotonic');
    }
    if (!Number.isFinite(event.observedAtMs)) {
      throw new Error('hosted_e2e_external_coordination_event_observation_invalid');
    }
    previousSequence = event.eventSequence;
  }
}

/**
 * Proves a resumed stream crossed its own replay completion boundary.  Headers
 * alone are not a completion boundary: a duplicate can still be buffered by
 * the resumed response.  The caller therefore records a heartbeat (the
 * server's durable replay watermark) from the resumed stream and the
 * following heartbeat with an unchanged durable cursor before calling this
 * assertion.  A time-only quiet window is not a replay boundary.
 */
export function assertHostedV1ExternalCoordinationReconnectProof(input: {
  readonly events: readonly HostedV1ExternalCoordinationObservedEvent[];
  readonly baselineCursor: string;
  readonly baselineOpens: number;
  readonly baselineReconnects: number;
  readonly baselineStreamId: number;
  readonly opens: number;
  readonly reconnects: number;
  readonly error: string | null;
  readonly heartbeatCursors: readonly string[];
  readonly heartbeatEventCounts: readonly number[];
  readonly heartbeatFrameIndexes: readonly number[];
  readonly heartbeatStreamIds: readonly number[];
  readonly heartbeatObservedAtMs: readonly number[];
  readonly observedAtMs: number;
  readonly originMs: number;
  readonly replayDeadlineMs: number;
  readonly reconnectStreamId: number;
  readonly targetEventId: string;
  readonly targetEventSequence: number;
}): void {
  if (
    !Number.isSafeInteger(input.baselineOpens) || input.baselineOpens < 1 ||
    !Number.isSafeInteger(input.baselineReconnects) || input.baselineReconnects < 0 ||
    !Number.isSafeInteger(input.baselineStreamId) || input.baselineStreamId !== input.baselineOpens ||
    !Number.isSafeInteger(input.reconnectStreamId) ||
    input.reconnectStreamId !== input.baselineStreamId + 1 ||
    input.opens !== input.reconnectStreamId || input.reconnects <= input.baselineReconnects ||
    input.error !== null ||
    !Number.isSafeInteger(input.targetEventSequence) || input.targetEventSequence < 0 ||
    !Number.isFinite(input.originMs) || !Number.isFinite(input.observedAtMs) ||
    !Number.isFinite(input.replayDeadlineMs) || input.replayDeadlineMs <= input.originMs ||
    input.observedAtMs > input.replayDeadlineMs
  ) {
    throw new Error('hosted_e2e_external_reconnect_completion_boundary_invalid');
  }
  const targets = input.events.filter((event) => event.eventId === input.targetEventId);
  if (targets.length !== 1) {
    throw new Error('hosted_e2e_external_reconnect_target_not_exactly_once');
  }
  const target = targets[0];
  if (!target) throw new Error('hosted_e2e_external_reconnect_target_not_exactly_once');
  if (!input.events.every((event) => Number.isFinite(event.observedAtMs))) {
    throw new Error('hosted_e2e_external_reconnect_event_observation_invalid');
  }
  if (target.eventSequence !== input.targetEventSequence) {
    throw new Error('hosted_e2e_external_reconnect_target_sequence_changed');
  }
  if (target.streamId > input.baselineOpens || !input.events.every((event) => event.streamId <= input.reconnectStreamId)) {
    throw new Error('hosted_e2e_external_reconnect_stream_identity_unstable');
  }
  const resumedHeartbeatIndexes = input.heartbeatStreamIds.flatMap((streamId, index) =>
    streamId === input.reconnectStreamId ? [index] : []
  );
  if (resumedHeartbeatIndexes.length < 2) {
    throw new Error('hosted_e2e_external_reconnect_completion_heartbeat_missing');
  }
  const replayStartHeartbeatIndex = resumedHeartbeatIndexes[0];
  const completionHeartbeatIndex = resumedHeartbeatIndexes[1];
  if (replayStartHeartbeatIndex === undefined || completionHeartbeatIndex === undefined) {
    throw new Error('hosted_e2e_external_reconnect_completion_heartbeat_missing');
  }
  const completionHeartbeatObservedAtMs = input.heartbeatObservedAtMs[completionHeartbeatIndex];
  const replayStartHeartbeatObservedAtMs = input.heartbeatObservedAtMs[replayStartHeartbeatIndex];
  const completionHeartbeatFrameIndex = input.heartbeatFrameIndexes[completionHeartbeatIndex];
  const replayStartHeartbeatFrameIndex = input.heartbeatFrameIndexes[replayStartHeartbeatIndex];
  if (
    typeof completionHeartbeatObservedAtMs !== 'number' ||
    !Number.isFinite(completionHeartbeatObservedAtMs) ||
    typeof replayStartHeartbeatObservedAtMs !== 'number' ||
    !Number.isFinite(replayStartHeartbeatObservedAtMs) ||
    typeof completionHeartbeatFrameIndex !== 'number' ||
    typeof replayStartHeartbeatFrameIndex !== 'number' ||
    completionHeartbeatObservedAtMs > input.replayDeadlineMs ||
    completionHeartbeatFrameIndex <= replayStartHeartbeatFrameIndex ||
    input.heartbeatCursors[replayStartHeartbeatIndex] !== input.baselineCursor ||
    input.heartbeatCursors[completionHeartbeatIndex] !== input.baselineCursor ||
    input.heartbeatCursors[replayStartHeartbeatIndex] !== input.heartbeatCursors[completionHeartbeatIndex] ||
    input.heartbeatEventCounts[replayStartHeartbeatIndex] !== input.heartbeatEventCounts[completionHeartbeatIndex]
  ) {
    throw new Error('hosted_e2e_external_reconnect_completion_boundary_invalid');
  }
}

/**
 * Captures and immediately validates the exact resumed-stream state selected
 * by a poll.  Keeping this as one operation is intentional: a second state
 * read or a Node-side clock read can race a later transport transition and
 * turn a proof that completed before its deadline into a false failure.
 */
export function captureAndAssertHostedV1ExternalCoordinationReconnectProof(input: {
  readonly baseline: HostedV1ExternalCoordinationReconnectBaseline;
  readonly stateReader: () => HostedV1ExternalCoordinationReconnectState | null;
  readonly originMs: number;
  readonly replayDeadlineMs: number;
  readonly targetEventId: string;
  readonly targetEventSequence: number;
}): HostedV1ExternalCoordinationReconnectProofCapture | null {
  const capture = captureHostedV1ExternalCoordinationReconnectProof({
    baseline: input.baseline,
    stateReader: input.stateReader,
  });
  if (capture === null) return null;

  const state = JSON.parse(
    capture.serializedState
  ) as HostedV1ExternalCoordinationReconnectState;
  assertHostedV1ExternalCoordinationReconnectProof({
    events: state.events,
    baselineCursor: input.baseline.cursor,
    baselineOpens: input.baseline.streamGeneration,
    baselineReconnects: input.baseline.reconnects,
    baselineStreamId: input.baseline.streamGeneration,
    opens: state.opens,
    reconnects: state.reconnects,
    error: state.error,
    heartbeatFrameIndexes: state.heartbeatFrameIndexes,
    heartbeatStreamIds: state.heartbeatStreamIds,
    heartbeatObservedAtMs: state.heartbeatObservedAtMs,
    heartbeatCursors: state.heartbeatCursors,
    heartbeatEventCounts: state.heartbeatEventCounts,
    observedAtMs: capture.observedAtMs,
    originMs: input.originMs,
    replayDeadlineMs: input.replayDeadlineMs,
    reconnectStreamId: input.baseline.streamGeneration + 1,
    targetEventId: input.targetEventId,
    targetEventSequence: input.targetEventSequence,
  });
  return capture;
}

export function assertHostedV1ScenarioIsolation(
  scenarios: readonly {
    readonly authMode: ScenarioMode;
    readonly caddyPublishedPort: number;
    readonly composeProject: string;
    readonly sandbox: HostedV1Sandbox;
  }[]
): void {
  if (scenarios.length !== 3 || new Set(scenarios.map(({ authMode }) => authMode)).size !== 3) {
    throw new Error('hosted_e2e_scenario_set_invalid');
  }
  const independentlyOwnedValues = scenarios.flatMap(
    ({ caddyPublishedPort, composeProject, sandbox }) => [
      sandbox.root,
      sandbox.appDataDir,
      sandbox.oidcAppDataDir,
      sandbox.claudeDir,
      sandbox.fakeRuntimeStateDir,
      sandbox.caddyDataDir,
      sandbox.lifecycleHighWaterDir,
      sandbox.lifecycleLauncherDir,
      sandbox.lifecycleRunDir,
      sandbox.lifecycleTrustDir,
      sandbox.runDir,
      sandbox.workspaceDir,
      sandbox.lifecycleTrustAnchor,
      composeProject,
      String(caddyPublishedPort),
    ]
  );
  if (new Set(independentlyOwnedValues).size !== independentlyOwnedValues.length) {
    throw new Error('hosted_e2e_scenario_state_leakage_risk');
  }
}

export async function createMarkerOwnedHostedV1ScenarioSandbox(
  root: string,
  createSandbox: (candidateRoot: string) => Promise<HostedV1Sandbox> = createHostedV1Sandbox
): Promise<HostedV1Sandbox> {
  const allocatedRoot = await lstat(root, { bigint: true });
  if (!allocatedRoot.isDirectory() || allocatedRoot.isSymbolicLink()) {
    throw new Error('hosted_e2e_allocated_scenario_root_invalid');
  }
  try {
    return await createSandbox(root);
  } catch (error) {
    let removed = false;
    const markerPath = join(root, '.agent-teams-hosted-v1-e2e-owner.json');
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        readonly marker?: unknown;
      };
      if (typeof marker.marker === 'string') {
        await assertHostedV1MarkerOwnedRoot(root, markerPath, marker.marker);
        await rm(root, { recursive: true });
        removed = true;
      }
    } catch {
      // Fall through to the exact allocation identity proof below.
    }
    if (!removed) {
      const currentRoot = await lstat(root, { bigint: true }).catch(() => null);
      if (
        currentRoot !== null &&
        currentRoot.isDirectory() &&
        !currentRoot.isSymbolicLink() &&
        currentRoot.dev === allocatedRoot.dev &&
        currentRoot.ino === allocatedRoot.ino
      ) {
        await rm(root, { recursive: true });
      }
    }
    throw error;
  }
}

export async function cleanupHostedV1SandboxRoots(input: {
  readonly sandboxes: readonly HostedV1Sandbox[];
  readonly retainedRoots?: ReadonlySet<string>;
  readonly assertMarkerOwned?: (sandbox: HostedV1Sandbox) => Promise<void>;
  readonly removeRoot?: (root: string) => Promise<void>;
}): Promise<{
  readonly cleanupError: AggregateError | null;
  readonly removedMarkers: readonly string[];
  readonly retainedMarkers: readonly string[];
}> {
  const errors: unknown[] = [];
  const removedMarkers: string[] = [];
  const retainedMarkers: string[] = [];
  const assertMarkerOwned =
    input.assertMarkerOwned ??
    ((sandbox: HostedV1Sandbox) =>
      assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker));
  const removeRoot = input.removeRoot ?? ((root: string) => rm(root, { recursive: true }));

  for (const sandbox of input.sandboxes) {
    if (input.retainedRoots?.has(sandbox.root) === true) {
      retainedMarkers.push(sandbox.marker);
      continue;
    }
    try {
      await assertMarkerOwned(sandbox);
    } catch (error) {
      errors.push(error);
      retainedMarkers.push(sandbox.marker);
      continue;
    }
    try {
      await removeRoot(sandbox.root);
      removedMarkers.push(sandbox.marker);
    } catch (error) {
      errors.push(error);
      retainedMarkers.push(sandbox.marker);
    }
  }

  return Object.freeze({
    cleanupError:
      errors.length === 0 ? null : new AggregateError(errors, 'hosted_e2e_sandbox_cleanup_failed'),
    removedMarkers: Object.freeze(removedMarkers),
    retainedMarkers: Object.freeze(retainedMarkers),
  });
}

async function runHostedV1Main(
  interrupts: ReturnType<typeof registerHostedV1InterruptHandlers>
): Promise<void> {
  // Fail before Docker or sandbox I/O when a caller requests an unknown suite.
  const browserSuite = parseHostedV1BrowserSuite(process.env.HOSTED_E2E_SUITE);
  const suiteDefinition = HOSTED_V1_BROWSER_SUITES[browserSuite];
  const browserCases = selectHostedV1BrowserCases(browserSuite, process.env.HOSTED_E2E_SCENARIOS);
  const scenarioDefinitions = suiteDefinition.authModes.flatMap((authMode) =>
    browserCases.map((browserCase) => ({
      authMode,
      browserCase,
      scenarioKey: `${authMode}-${browserCase.id}`,
    }))
  );
  const nodeDigest = envDigest('NODE_IMAGE_DIGEST');
  const caddyDigest = envDigest('CADDY_IMAGE_DIGEST');
  const keycloakDigest = envDigest('KEYCLOAK_IMAGE_DIGEST');
  await run('docker', ['version'], { capture: true });
  await access(composeFile);

  const root = await mkdtemp(join(await realpath(tmpdir()), 'agent-teams-hosted-v1-e2e-'));
  const sandbox = await createMarkerOwnedHostedV1ScenarioSandbox(root);

  const artifactOwner = invokingSudoOwner();
  let artifactDirectory: string;
  try {
    artifactDirectory = await createEvidenceDirectory(sandbox, artifactOwner);
  } catch (error) {
    await assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker);
    await rm(sandbox.root, { recursive: true });
    throw error;
  }
  const retainedScenarioRoots = new Set<string>();
  let runnerError: unknown = null;
  let interruptedCleanupSignalScope: ReturnType<typeof beginHostedV1CleanupSignalScope> | null =
    null;
  const appImage = `at-hosted-v1-${sandbox.marker.slice(0, 24)}-app:latest`;
  let sourceDeclaration: HostedV1SourceDeclaration | null = null;
  let appImageEvidence: HostedV1AppImageEvidence | null = null;
  const sharedAppImageLifecycle = createHostedV1SharedAppImageLifecycle({
    appImage,
    environment: sanitizedEnvironment,
    removeImage: (image, environment) =>
      removeHostedV1AppImage(image, environment, (args, dockerEnvironment) =>
        run('docker', [...args], { capture: true, env: dockerEnvironment })
      ),
  });
  const sandboxes: HostedV1Sandbox[] = [sandbox];
  const registeredScenarioRoots = new Set<string>([sandbox.root]);
  const composeProjects: Record<string, string> = {};
  try {
    const runSourceDeclaration = await collectHostedV1SourceDeclaration();
    sourceDeclaration = runSourceDeclaration;
    await writeEvidence(
      join(artifactDirectory, 'source-declaration.json'),
      JSON.stringify(runSourceDeclaration, null, 2)
    );
    for (let index = 1; index < scenarioDefinitions.length; index += 1) {
      const scenarioRoot = await mkdtemp(
        join(
          await realpath(tmpdir()),
          `agent-teams-hosted-v1-e2e-${scenarioDefinitions[index]?.scenarioKey ?? 'missing'}-`
        )
      );
      registeredScenarioRoots.add(scenarioRoot);
      sandboxes.push(await createMarkerOwnedHostedV1ScenarioSandbox(scenarioRoot));
    }
    const caddyPublishedPorts = allocateHostedV1CaddyPublishedPorts(
      sandboxes.map((scenarioSandbox) => scenarioSandbox.marker)
    );
    const scenarioAllocations = scenarioDefinitions.map((definition, index) => {
      const scenarioSandbox = sandboxes[index];
      const caddyPublishedPort = caddyPublishedPorts[index];
      if (!scenarioSandbox) throw new Error('hosted_e2e_scenario_sandbox_missing');
      if (caddyPublishedPort === undefined) throw new Error('hosted_e2e_scenario_port_missing');
      return {
        authMode: definition.authMode,
        scenarioKey: definition.scenarioKey,
        sandbox: scenarioSandbox,
        composeProject: `at-hosted-v1-${scenarioSandbox.marker.slice(0, 24)}`,
        caddyPublishedPort,
      };
    });
    if (browserSuite === 'core') {
      assertHostedV1ScenarioIsolation(scenarioAllocations);
    } else if (
      new Set(scenarioAllocations.map(({ sandbox: allocation }) => allocation.root)).size !==
        scenarioAllocations.length ||
      new Set(scenarioAllocations.map(({ composeProject }) => composeProject)).size !==
        scenarioAllocations.length ||
      new Set(scenarioAllocations.map(({ caddyPublishedPort }) => caddyPublishedPort)).size !==
        scenarioAllocations.length
    ) {
      throw new Error('hosted_e2e_scenario_isolation_invalid');
    }
    if (
      registeredScenarioRoots.size !== scenarioDefinitions.length ||
      sandboxes.some(({ root }) => !registeredScenarioRoots.has(root))
    ) {
      throw new Error('hosted_e2e_scenario_root_registration_invalid');
    }
    if (process.getuid?.() !== 0)
      throw new Error('hosted_e2e_requires_root_for_image_lock_fixture');
    const appUid = 1000;
    const appGid = 1000;
    const domain = 'hosted-v1-e2e.localhost';
    const oidcDomain = 'oidc-v1-e2e.localhost';

    const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!browserPath || !isAbsolute(browserPath)) {
      throw new Error('PLAYWRIGHT_BROWSERS_PATH must name the preinstalled Chromium cache');
    }
    const browserEnvironment: NodeJS.ProcessEnv = {
      ...sanitizedEnvironment,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
    };
    const eventCursor = encodeReplayCursor({
      deploymentId,
      eventEpoch: `epoch-initial-v1-${createHash('sha256').update(deploymentId).digest('hex').slice(0, 24)}`,
      eventSequence: 0,
    });

    for (const [index, definition] of scenarioDefinitions.entries()) {
      const { authMode, browserCase, scenarioKey } = definition;
      const scenarioSandbox = sandboxes[index];
      if (!scenarioSandbox) throw new Error('hosted_e2e_scenario_sandbox_missing');
      await restoreHostedV1NodeAbi({
        environment: sanitizedEnvironment,
        runNode: (args, environment) =>
          run('node', args, { env: environment }).then(() => undefined),
      });
      const scannerEvidence = await collectHostedV1ScannerEvidence(scenarioSandbox);
      const projectSuffix = scenarioSandbox.marker.slice(0, 24);
      const composeProject = `at-hosted-v1-${projectSuffix}`;
      if (!projectSuffix || composeProject.length > 63) throw new Error('e2e_project_name_invalid');
      composeProjects[scenarioKey] = composeProject;
      const network = networkAddresses(scenarioSandbox.marker);
      const caddyPublishedPort = scenarioAllocations[index]?.caddyPublishedPort;
      if (caddyPublishedPort === undefined) throw new Error('hosted_e2e_scenario_port_missing');
      const expectedOidcIssuer = `https://${oidcDomain}:${caddyPublishedPort}`;
      const appDataDir =
        authMode === 'personal' ? scenarioSandbox.appDataDir : scenarioSandbox.oidcAppDataDir;
      await run('node', ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'], {
        env: {
          ...sanitizedEnvironment,
          E2E_SEED_APP_DATA_ROOT: appDataDir,
          E2E_SEED_AUTH_MODE: authMode === 'personal' ? 'personal' : 'oidc',
          E2E_SEED_CLAUDE_ROOT: scenarioSandbox.claudeDir,
          ...(browserCase.id === 'slow-consumer'
            ? { E2E_SEED_COORDINATION_EVENT_COUNT: '16384' }
            : {}),
          E2E_FAKE_RUNTIME_STATE_ROOT: scenarioSandbox.fakeRuntimeStateDir,
          E2E_SEED_MARKER_PATH: scenarioSandbox.markerPath,
          E2E_SEED_OIDC_ISSUER: expectedOidcIssuer,
        },
      });
      const dataDir = join(appDataDir, 'data');
      const lockDir = join(appDataDir, 'instance-lock');
      const lockPath = join(lockDir, 'instance.lock');
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await mkdir(lockDir, { recursive: true, mode: 0o555 });
      await writeFile(lockPath, '', { mode: 0o444 });
      await chown(appDataDir, 0, appGid);
      await chmod(appDataDir, 0o1770);
      await chown(lockDir, 0, 0);
      await chmod(lockDir, 0o555);
      await chown(lockPath, 0, 0);
      await chmod(lockPath, 0o444);
      for (const writable of [dataDir, join(appDataDir, 'storage'), join(appDataDir, 'logs')]) {
        await chownTree(writable, appUid, appGid);
        await chmod(writable, 0o700);
      }
      await Promise.all(
        [
          scenarioSandbox.caddyDataDir,
          scenarioSandbox.claudeDir,
          scenarioSandbox.fakeRuntimeStateDir,
          scenarioSandbox.lifecycleHighWaterDir,
          scenarioSandbox.lifecycleLauncherDir,
          scenarioSandbox.lifecycleRunDir,
          scenarioSandbox.lifecycleTrustDir,
          scenarioSandbox.runDir,
          scenarioSandbox.workspaceDir,
        ].map((path) => chownTree(path, appUid, appGid))
      );
      const baseComposeEnv: NodeJS.ProcessEnv = {
        ...browserEnvironment,
        CADDY_IMAGE_DIGEST: caddyDigest,
        COMPOSE_FILE: composeFile,
        COMPOSE_PROJECT_NAME: composeProject,
        E2E_APP_GID: String(appGid),
        E2E_APP_IMAGE: appImage,
        E2E_APP_IP: network.app,
        E2E_APP_UID: String(appUid),
        E2E_CADDY_DATA_DIR: scenarioSandbox.caddyDataDir,
        E2E_CADDY_IP: network.caddy,
        E2E_CADDY_PUBLISHED_PORT: String(caddyPublishedPort),
        E2E_CLAUDE_DIR: scenarioSandbox.claudeDir,
        E2E_BOOT_ID: `boot_hosted-v1-e2e-${scenarioSandbox.marker}`,
        E2E_FAKE_RUNTIME_STATE_DIR: scenarioSandbox.fakeRuntimeStateDir,
        E2E_LIFECYCLE_BOOTSTRAP: scenarioSandbox.bootstrap,
        E2E_LIFECYCLE_HIGH_WATER_DIR: scenarioSandbox.lifecycleHighWaterDir,
        E2E_LIFECYCLE_LAUNCHER_DIR: scenarioSandbox.lifecycleLauncherDir,
        E2E_LIFECYCLE_RUN_DIR: scenarioSandbox.lifecycleRunDir,
        E2E_LIFECYCLE_TRUST_DIR: scenarioSandbox.lifecycleTrustDir,
        E2E_INGRESS_NETWORK_SUBNET: network.ingressSubnet,
        E2E_NETWORK_SUBNET: network.subnet,
        E2E_OIDC_IP: network.oidc,
        E2E_OWNER_MARKER: scenarioSandbox.markerPath,
        E2E_RUN_DIR: scenarioSandbox.runDir,
        E2E_SOURCE_HEAD_COMMIT: runSourceDeclaration.headCommit,
        E2E_SOURCE_PATCH_SHA256: runSourceDeclaration.patchSha256,
        E2E_RUNTIME_WORKSPACE_ID,
        E2E_TEAM_RUNTIME_WORKSPACE_ID,
        E2E_TEAM_ID,
        E2E_WORKSPACE_DIR: scenarioSandbox.workspaceDir,
        HOSTED_E2E_RETENTION_INTERVAL_MS: browserCase.id === 'retention-resync' ? '100' : '60000',
        HOSTED_E2E_RETENTION_MAX_EVENTS:
          browserCase.id === 'retention-resync'
            ? '1'
            : browserCase.id === 'slow-consumer'
              ? '20000'
              : '10000',
        HOSTED_DOMAIN: domain,
        NODE_IMAGE_DIGEST: nodeDigest,
        KEYCLOAK_IMAGE_DIGEST: keycloakDigest,
        OIDC_DOMAIN: oidcDomain,
      };
      const composeArgs = ['compose', '--project-name', composeProject, '--file', composeFile];
      const createScenarioEnvironment = (port: number): NodeJS.ProcessEnv => {
        const origin = `https://${domain}:${port}`;
        return {
          ...baseComposeEnv,
          E2E_APP_DATA_DIR: appDataDir,
          HOSTED_E2E_AUTH_MODE: authMode === 'personal' ? 'personal' : 'oidc',
          HOSTED_E2E_OIDC_ORIGIN: `https://${oidcDomain}:${port}`,
          HOSTED_E2E_OIDC_ROLE: authMode === 'oidc-viewer' ? 'viewer' : 'owner',
          HOSTED_E2E_ORIGIN: origin,
          HOSTED_HTTPS_PORT: String(port),
        };
      };
      let composeEnv = createScenarioEnvironment(caddyPublishedPort);
      let pairingCode: string | null = null;
      let caddyPublisherObservation: string | null = null;
      let lifecycleOwnerObservation: string | null = null;
      const controllerProjectObservationFile = join(
        scenarioSandbox.runDir,
        `controller-projects-${scenarioKey}.json`
      );
      await writeFile(
        controllerProjectObservationFile,
        `${JSON.stringify({ status: 'unavailable' })}\n`,
        { mode: 0o600 }
      );
      let scenarioError: unknown = null;
      let scenarioCompleted = false;
      let composeAttempted = false;
      try {
        composeAttempted = true;
        composeEnv = await runComposeUpWithExplicitPort({
          ...(index === 0
            ? {
                buildImage: async () => {
                  sharedAppImageLifecycle.markBuildAttempted();
                  await buildHostedV1AppImage({
                    composeArgs,
                    environment: createScenarioEnvironment(caddyPublishedPort),
                    runDocker: (args, environment, timeoutMs) =>
                      run('docker', [...args], { env: environment, timeoutMs }).then(
                        () => undefined
                      ),
                  });
                  appImageEvidence = await inspectHostedV1AppImage(
                    appImage,
                    runSourceDeclaration,
                    createScenarioEnvironment(caddyPublishedPort)
                  );
                  await writeEvidence(
                    join(artifactDirectory, 'app-image-evidence.json'),
                    JSON.stringify(appImageEvidence, null, 2)
                  );
                },
              }
            : {}),
          createEnvironment: (port) => {
            composeEnv = createScenarioEnvironment(port);
            return composeEnv;
          },
          publishedPort: caddyPublishedPort,
          startCaddy: (environment) =>
            run('docker', [...composeArgs, 'up', '--no-build', '--detach', '--wait', 'caddy'], {
              env: environment,
              capture: true,
            }).then(() => undefined),
          readCaddyPublishers: async (environment) => {
            caddyPublisherObservation = await run(
              'docker',
              [...composeArgs, 'ps', '--format', 'json', 'caddy'],
              { env: environment, capture: true }
            );
            return caddyPublisherObservation;
          },
          startRemainingServices: (environment) =>
            run(
              'docker',
              [...composeArgs, 'up', '--no-build', '--detach', '--wait', '--no-recreate'],
              { env: environment, capture: true }
            ).then(() => undefined),
        });
        for (const service of ['hosted-controller', 'synthetic-oidc', 'fake-runtime'] as const) {
          const observation = await run(
            'docker',
            [...composeArgs, 'ps', '--format', 'json', service],
            {
              env: composeEnv,
              capture: true,
            }
          );
          assertDockerComposeServiceNotPublished(observation, service);
          if (service === 'fake-runtime') lifecycleOwnerObservation = observation;
        }
        if (lifecycleOwnerObservation === null) {
          throw new Error('hosted_e2e_lifecycle_owner_observation_missing');
        }
        const scenarioEvidenceDirectory = join(artifactDirectory, scenarioKey);
        await mkdir(scenarioEvidenceDirectory, { recursive: true, mode: 0o700 });
        await writeEvidence(
          join(scenarioEvidenceDirectory, 'lifecycle-owner-deployment.json'),
          redactEvidence(lifecycleOwnerObservation, scenarioSandbox, pairingCode)
        );
        if (authMode === 'personal') {
          pairingCode = await run(
            'docker',
            [
              ...composeArgs,
              'exec',
              '-T',
              'hosted-controller',
              'node',
              'scripts/hosted-auth-cli.mjs',
              'pairing-code',
            ],
            { env: composeEnv, capture: true }
          );
          if (!/^[A-Za-z0-9_-]{32,}$/.test(pairingCode)) {
            throw new Error('hosted_e2e_pairing_code_invalid');
          }
        }

        const runtimeFile = join(root, `runtime-${scenarioKey}.json`);
        await writeFile(
          runtimeFile,
          `${JSON.stringify({
            authMode,
            composeFile,
            composeProject,
            controllerProjectObservationFile,
            claudeDir: scenarioSandbox.claudeDir,
            eventCursor,
            fakeRuntimeLifecycleTraceFile: join(
              scenarioSandbox.fakeRuntimeStateDir,
              'lifecycle-trace.json'
            ),
            fakeRuntimeStateFile: join(scenarioSandbox.fakeRuntimeStateDir, 'runtime-state.json'),
            fakeRuntimeStateDir: scenarioSandbox.fakeRuntimeStateDir,
            appDataDir,
            forbiddenWorkspaceId: E2E_FORBIDDEN_WORKSPACE_ID,
            origin: composeEnv.HOSTED_E2E_ORIGIN,
            pairingCode,
            sandboxRoot: scenarioSandbox.root,
            lifecycleTrustAnchor: scenarioSandbox.lifecycleTrustAnchor,
            projectWorkspaceId: E2E_PROJECT_WORKSPACE_ID,
            runtimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID,
            teamId: E2E_TEAM_ID,
            teamName: E2E_TEAM_NAME,
            teamRuntimeWorkspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
            workspaceId: E2E_WORKSPACE_ID,
            workspaceDir: scenarioSandbox.workspaceDir,
          })}\n`,
          { mode: 0o600 }
        );
        const outputDirectory = join(artifactDirectory, scenarioKey, 'playwright');
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        try {
          await run(
            'pnpm',
            [
              'exec',
              'playwright',
              'test',
              '--config',
              playwrightConfig,
              ...(browserCase.grep === null ? [] : ['--grep', browserCase.grep]),
            ],
            {
              env: {
                ...composeEnv,
                HOSTED_E2E_RUNTIME_FILE: runtimeFile,
                HOSTED_E2E_OUTPUT_DIR: outputDirectory,
                HOSTED_E2E_SUITE: browserSuite,
              },
            }
          );
        } finally {
          await sanitizePlaywrightEvidence(outputDirectory, scenarioSandbox, pairingCode);
        }
        scenarioCompleted = true;
      } catch (error) {
        scenarioError = error;
        await captureFailureEvidence({
          artifactDirectory,
          artifactKey: scenarioKey,
          authMode,
          caddyPublisherObservation,
          composeArgs,
          composeEnv,
          controllerProjectObservationFile,
          error,
          expectedOidcIssuer,
          pairingCode,
          scannerEvidence,
          sandbox: scenarioSandbox,
        });
      } finally {
        const scenarioCleanupSignalScope = beginHostedV1CleanupSignalScope({
          activeSignal: activeRunAbortSignal ?? interrupts.signal,
          replaceActiveSignal: (signal) => {
            activeRunAbortSignal = signal;
          },
        });
        try {
          if (composeAttempted) {
            try {
              await run(
                'docker',
                [...composeArgs, 'down', '--timeout', '30', '--volumes', '--remove-orphans'],
                { env: composeEnv }
              );
              const [containers, networks, volumes] = await Promise.all([
                run('docker', [...composeArgs, 'ps', '--all', '--quiet'], {
                  env: composeEnv,
                  capture: true,
                }),
                run(
                  'docker',
                  [
                    'network',
                    'ls',
                    '--filter',
                    `label=com.docker.compose.project=${composeProject}`,
                    '--quiet',
                  ],
                  { env: composeEnv, capture: true }
                ),
                run(
                  'docker',
                  [
                    'volume',
                    'ls',
                    '--filter',
                    `label=com.docker.compose.project=${composeProject}`,
                    '--quiet',
                  ],
                  { env: composeEnv, capture: true }
                ),
              ]);
              assertNoComposeResourcesRemain({ containers, networks, volumes });
            } catch (cleanupError) {
              retainedScenarioRoots.add(scenarioSandbox.root);
              scenarioError = new AggregateError(
                [scenarioError, cleanupError].filter((value) => value !== null),
                'hosted_e2e_compose_cleanup_failed'
              );
              await captureFailureEvidence({
                artifactDirectory,
                artifactKey: scenarioKey,
                authMode,
                caddyPublisherObservation,
                composeArgs,
                composeEnv,
                controllerProjectObservationFile,
                error: scenarioError,
                expectedOidcIssuer,
                pairingCode,
                scannerEvidence,
                sandbox: scenarioSandbox,
              });
            }
          }
        } finally {
          if (scenarioCleanupSignalScope.interruptedSignal.aborted) {
            scenarioError ??=
              scenarioCleanupSignalScope.interruptedSignal.reason instanceof Error
                ? scenarioCleanupSignalScope.interruptedSignal.reason
                : new Error('hosted_e2e_interrupted');
            interruptedCleanupSignalScope = scenarioCleanupSignalScope;
          } else {
            scenarioCleanupSignalScope.restore();
          }
        }
      }
      if (scenarioError !== null) {
        throw new Error(
          `hosted_e2e_${scenarioKey}_failed; evidence retained at ${artifactDirectory}`,
          { cause: scenarioError }
        );
      }
      if (!scenarioCompleted || sourceDeclaration === null || appImageEvidence === null) {
        throw new Error('hosted_e2e_scenario_evidence_incomplete');
      }
      await writeEvidence(
        join(artifactDirectory, scenarioKey, 'result.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            authMode,
            browserCase: browserCase.id,
            status: 'passed',
            cleanup: 'verified',
            lifecycleOwner: {
              service: 'fake-runtime',
              externalToController: true,
              singleton: true,
              published: false,
              observationSha256: createHash('sha256')
                .update(lifecycleOwnerObservation ?? '')
                .digest('hex'),
            },
            sourceDeclaration,
            image: appImageEvidence,
          },
          null,
          2
        )
      );
    }
  } catch (error) {
    runnerError = error;
    await writeEvidence(
      join(artifactDirectory, 'runner-failure.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          status: 'failed',
          error: sandboxes.reduce(
            (redacted, scenarioSandbox) => redactEvidence(redacted, scenarioSandbox, null),
            safeError(error)
          ),
        },
        null,
        2
      )
    ).catch(() => undefined);
  } finally {
    const outerCleanupSignalScope =
      interruptedCleanupSignalScope ??
      beginHostedV1CleanupSignalScope({
        activeSignal: activeRunAbortSignal ?? interrupts.signal,
        replaceActiveSignal: (signal) => {
          activeRunAbortSignal = signal;
        },
      });
    runnerError = mergeHostedV1CleanupInterruption(
      outerCleanupSignalScope.interruptedSignal,
      runnerError
    );
    try {
      const imageCleanup = await sharedAppImageLifecycle.cleanup(runnerError);
      runnerError = imageCleanup.runnerError;
      if (runnerError === null) {
        if (sourceDeclaration === null || appImageEvidence === null) {
          runnerError = new Error('hosted_e2e_final_evidence_incomplete');
        } else {
          try {
            const finalSourceDeclaration = await collectHostedV1SourceDeclaration();
            if (JSON.stringify(finalSourceDeclaration) !== JSON.stringify(sourceDeclaration)) {
              runnerError = new Error('hosted_e2e_source_declaration_changed_during_run');
            }
          } catch (error) {
            runnerError = error;
          }
        }
      }
      const sandboxCleanup = await cleanupHostedV1SandboxRoots({
        sandboxes,
        retainedRoots: retainedScenarioRoots,
      });
      if (sandboxCleanup.cleanupError !== null) {
        runnerError = new AggregateError(
          [runnerError, ...sandboxCleanup.cleanupError.errors].filter((value) => value !== null),
          'hosted_e2e_sandbox_cleanup_failed'
        );
      }
      if (sandboxCleanup.retainedMarkers.length > 0) {
        await writeEvidence(
          join(artifactDirectory, 'leftovers.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              status: 'cleanup_failed',
              markers: sandboxCleanup.retainedMarkers,
              sandboxRoots: sandboxCleanup.retainedMarkers.map(() => '<sandbox-root>'),
            },
            null,
            2
          )
        );
      }
      if (runnerError === null && sourceDeclaration !== null && appImageEvidence !== null) {
        await writeEvidence(
          join(artifactDirectory, 'result.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              status: 'passed',
              browserSuite,
              scenarios: scenarioDefinitions.map(({ authMode, browserCase, scenarioKey }) => ({
                authMode,
                browserCase: browserCase.id,
                scenarioKey,
              })),
              composeProjects,
              cleanup: { composeResources: 'verified', sharedAppImageRemoved: true },
              sourceDeclaration,
              image: appImageEvidence,
            },
            null,
            2
          )
        );
      } else if (runnerError !== null) {
        await writeEvidence(
          join(artifactDirectory, 'runner-failure.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              status: 'failed',
              error: sandboxes.reduce(
                (redacted, scenarioSandbox) => redactEvidence(redacted, scenarioSandbox, null),
                safeError(runnerError)
              ),
            },
            null,
            2
          )
        ).catch(() => undefined);
      }
      if (artifactOwner !== null) {
        await chownTree(artifactDirectory, artifactOwner.uid, artifactOwner.gid);
      }
      runnerError = mergeHostedV1CleanupInterruption(
        outerCleanupSignalScope.interruptedSignal,
        runnerError
      );
      if (runnerError !== null) {
        await rm(join(artifactDirectory, 'result.json'), { force: true });
        await writeEvidence(
          join(artifactDirectory, 'runner-failure.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              status: 'failed',
              error: sandboxes.reduce(
                (redacted, scenarioSandbox) => redactEvidence(redacted, scenarioSandbox, null),
                safeError(runnerError)
              ),
            },
            null,
            2
          )
        ).catch(() => undefined);
      }
    } finally {
      outerCleanupSignalScope.restore();
    }
  }
  if (runnerError !== null) throw runnerError;
  process.stdout.write(`Hosted v1 E2E evidence: ${artifactDirectory}\n`);
}

async function main(): Promise<void> {
  const interrupts = registerHostedV1InterruptHandlers({
    once: (signal, listener) => process.once(signal, listener),
    remove: (signal, listener) => process.removeListener(signal, listener),
  });
  activeRunAbortSignal = interrupts.signal;
  try {
    await runHostedV1Main(interrupts);
  } finally {
    activeRunAbortSignal = undefined;
    interrupts.dispose();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
