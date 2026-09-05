import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  readonly body: () => Promise<Uint8Array>;
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

export interface HostedV1ProbeDeadlineBudget {
  readonly overallDeadlineMs: number;
  readonly remainingMs: () => number;
  readonly nextAttemptTimeoutMs: () => number;
  readonly clipRetryDelayMs: (requestedDelayMs: number) => number;
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
 * Captures the already-observed Playwright response without replaying its request. Playwright's
 * `body()` buffers the entire decoded entity, so it is called only after the original header array
 * proves one identity-encoded Content-Length within the hard byte cap. Responses without that
 * transport proof are deliberately unusable as bounded E2E evidence.
 */
export async function captureOriginalHostedV1HttpResponse(
  response: HostedV1OriginalHttpResponseLike,
  input: {
    readonly maximumBytes: number;
    readonly overallDeadlineAtMs: number;
  }
): Promise<HostedV1OriginalHttpResponseCapture> {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 0 ||
    !Number.isSafeInteger(input.overallDeadlineAtMs)
  ) {
    throw new Error('hosted_e2e_original_response_limits_invalid');
  }

  const headers = await response.headersArray();
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
  const normalizedMaximum = String(input.maximumBytes);
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

  const remainingMs = input.overallDeadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new Error('hosted_e2e_original_response_deadline');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const bodyBytes = await Promise.race([
    response.body(),
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('hosted_e2e_original_response_deadline')),
        remainingMs
      );
    }),
  ]).finally(() => {
    if (deadline !== undefined) clearTimeout(deadline);
  });
  if (!(bodyBytes instanceof Uint8Array) || bodyBytes.byteLength !== declaredBodyBytes) {
    throw new Error('hosted_e2e_original_response_content_length_mismatch');
  }
  let rawBody: string;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
  } catch {
    throw new Error('hosted_e2e_original_response_body_utf8_invalid');
  }
  const request = response.request();
  return Object.freeze({
    capture: 'playwright_original_response',
    method: request.method(),
    url: response.url(),
    status: response.status(),
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
  sandbox: HostedV1Sandbox,
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
        /((?:^|\s)--?(?:api[_-]?key|[^\s]*(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^\s]*)\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gimu,
        '$1<sensitive-value>'
      )
      .replace(
        /(["']?(?:api[_-]?key|[^\s"':=,;]*(?:token|secret|password|passwd|passphrase|credential|private[_-]?key|trust[_-]?anchor)[^\s"':=,;]*)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
        (_match, prefix: string) => {
          const key = /["']?([^\s"':=]+)["']?\s*[:=]\s*$/u.exec(prefix)?.[1] ?? '';
          return `${prefix}${placeholderForKey(key) ?? '<sensitive-value>'}`;
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
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('hosted_e2e_playwright_artifact_symlink_forbidden');
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('hosted_e2e_playwright_artifact_type_forbidden');
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
  readonly oidc: string;
  readonly subnet: string;
} {
  const value = Number.parseInt(marker.slice(0, 4), 16);
  const prefix = `10.${64 + ((value >> 8) % 64)}.${value & 0xff}`;
  return Object.freeze({
    app: `${prefix}.3`,
    caddy: `${prefix}.2`,
    oidc: `${prefix}.4`,
    subnet: `${prefix}.0/28`,
  });
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
