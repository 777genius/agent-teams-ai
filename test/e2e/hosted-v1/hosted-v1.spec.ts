import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { connect, type IncomingHttpHeaders, type IncomingHttpStatusHeader } from 'node:http2';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  expect,
  type Page,
  type Request,
  type Response,
  test,
  type TestInfo,
} from '@playwright/test';

import {
  captureOriginalHostedV1HttpResponse,
  createHostedV1ProbeDeadlineBudget,
  type HostedV1ProbeDeadlineBudget,
  restartHostedV1LifecycleOwner,
} from '../../../scripts/e2e/hosted-v1/run';
import { advanceHostedV1MountGeneration } from '../../fixtures/hosted-v1/createSandbox';

interface RuntimeInput {
  readonly authMode: 'oidc' | 'oidc-viewer' | 'personal';
  readonly composeFile: string;
  readonly composeProject: string;
  readonly controllerProjectObservationFile: string;
  readonly eventCursor: string;
  readonly fakeRuntimeLifecycleTraceFile: string;
  readonly fakeRuntimeStateFile: string;
  readonly forbiddenWorkspaceId: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly projectWorkspaceId: string;
  readonly runtimeWorkspaceId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly workspaceId: string;
}

const runtimePath = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimePath) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeInput;
const fakeRuntimeOwnerMutationErrorTraceFile = resolve(
  runtime.fakeRuntimeLifecycleTraceFile,
  '..',
  'owner-mutation-error-trace.json'
);
if (
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.workspaceId) ||
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.projectWorkspaceId) ||
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.forbiddenWorkspaceId) ||
  new Set([runtime.workspaceId, runtime.projectWorkspaceId, runtime.forbiddenWorkspaceId]).size !==
    3
) {
  throw new Error('hosted_e2e_workspace_identity_invalid');
}
const execFileAsync = promisify(execFile);
const composeFile = process.env.COMPOSE_FILE;
const composeProject = process.env.COMPOSE_PROJECT_NAME;

if (
  !composeFile ||
  !composeProject ||
  !isAbsolute(composeFile) ||
  resolve(composeFile) !== composeFile ||
  (await realpath(composeFile)) !== composeFile ||
  composeFile !== runtime.composeFile ||
  composeProject !== runtime.composeProject ||
  !/^at-hosted-v1-[0-9a-f]{24}$/u.test(composeProject)
) {
  throw new Error('hosted_e2e_compose_context_invalid');
}
const validatedComposeFile = composeFile;
const validatedComposeProject = composeProject;
// The fake runtime is a separate process and therefore cannot use the
// controller's in-process wakeup hint. Durable replay observes its commit on
// the stream's 15-second heartbeat instead.
const EXTERNAL_COORDINATION_EVENT_REPLAY_TIMEOUT_MS = 25_000;
const E2E_DOCKER_COMMAND_TIMEOUT_MS = 60_000;
const E2E_PROBE_RESPONSE_MAX_BYTES = 64 * 1024;
const E2E_PROBE_ATTEMPT_TIMEOUT_MS = 5_000;

declare global {
  interface Window {
    __hostedE2eProbe(
      input: string,
      init?: RequestInit,
      options?: {
        readonly attemptTimeoutMs?: number;
        readonly maximumBytes?: number;
        readonly overallDeadlineAtMs?: number;
      }
    ): Promise<{
      readonly status: number;
      readonly rawBody: string;
      readonly body: unknown;
    }>;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ defaultAttemptTimeoutMs, defaultMaximumBytes }) => {
      const nativeFetch = window.fetch.bind(window);
      window.__hostedE2eProbe = async (input, init = {}, options = {}) => {
        const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
        const attemptTimeoutMs = options.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
        const overallDeadlineAtMs =
          options.overallDeadlineAtMs ?? Date.now() + defaultAttemptTimeoutMs;
        if (
          !Number.isSafeInteger(maximumBytes) ||
          maximumBytes < 0 ||
          !Number.isSafeInteger(attemptTimeoutMs) ||
          attemptTimeoutMs < 1 ||
          !Number.isSafeInteger(overallDeadlineAtMs)
        ) {
          throw new Error('hosted_e2e_probe_limits_invalid');
        }
        const remainingMs = overallDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw new Error('hosted_e2e_probe_overall_deadline');
        const controller = new AbortController();
        const signal = init.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;
        const timeout = window.setTimeout(
          () => controller.abort(new Error('hosted_e2e_probe_attempt_deadline')),
          Math.max(1, Math.min(attemptTimeoutMs, remainingMs))
        );
        try {
          const response = await nativeFetch(input, { ...init, signal });
          const contentLength = response.headers.get('content-length');
          if (contentLength !== null) {
            if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
              const error = new Error('hosted_e2e_probe_content_length_invalid');
              void response.body?.cancel(error).catch(() => undefined);
              throw error;
            }
            const declaredBytes = Number(contentLength);
            if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
              const error = new Error('hosted_e2e_probe_body_too_large');
              void response.body?.cancel(error).catch(() => undefined);
              throw error;
            }
          }
          const chunks: Uint8Array[] = [];
          let receivedBytes = 0;
          if (response.body !== null) {
            const reader = response.body.getReader();
            let removeAbortListener = (): void => undefined;
            const abortRead = new Promise<never>((_resolve, reject) => {
              const onAbort = () => {
                void reader.cancel(signal.reason).catch(() => undefined);
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error('hosted_e2e_probe_attempt_deadline')
                );
              };
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
              if (signal.aborted) onAbort();
            });
            try {
              for (;;) {
                const { done, value } = await Promise.race([reader.read(), abortRead]);
                if (done) break;
                receivedBytes += value.byteLength;
                if (receivedBytes > maximumBytes) {
                  void reader.cancel('hosted_e2e_probe_body_too_large').catch(() => undefined);
                  throw new Error('hosted_e2e_probe_body_too_large');
                }
                chunks.push(new Uint8Array(value));
              }
            } finally {
              removeAbortListener();
            }
          }
          const bytes = new Uint8Array(receivedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          let rawBody: string;
          try {
            rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            throw new Error('hosted_e2e_probe_body_utf8_invalid');
          }
          let body: unknown = rawBody;
          try {
            body = JSON.parse(rawBody);
          } catch {
            // Some negative probes deliberately return an empty or non-JSON body.
          }
          return { status: response.status, rawBody, body };
        } finally {
          window.clearTimeout(timeout);
        }
      };
      window.fetch = (input, init = {}) =>
        nativeFetch(input, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(10_000),
        });
    },
    {
      defaultAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
      defaultMaximumBytes: E2E_PROBE_RESPONSE_MAX_BYTES,
    }
  );
});

async function exactRuntimeTeamButton(page: Page) {
  const row = page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${runtime.teamId}"]`
  );
  await expect(row).toHaveCount(1);
  const button = row.getByRole('button');
  await expect(button).toHaveCount(1);
  return button;
}

async function compose(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    'docker',
    ['compose', '--project-name', validatedComposeProject, '--file', validatedComposeFile, ...args],
    {
      env: {
        ...process.env,
        COMPOSE_FILE: validatedComposeFile,
        COMPOSE_PROJECT_NAME: validatedComposeProject,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: E2E_DOCKER_COMMAND_TIMEOUT_MS,
    }
  );
  return `${result.stdout}${result.stderr}`;
}

async function docker(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', [...args], {
    env: {
      ...process.env,
      COMPOSE_FILE: validatedComposeFile,
      COMPOSE_PROJECT_NAME: validatedComposeProject,
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: E2E_DOCKER_COMMAND_TIMEOUT_MS,
  });
  return `${result.stdout}${result.stderr}`;
}

async function snapshotDirectoryFiles(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(resolve(directory, name), 'utf8')] as const)
    )
  );
}

async function selectRegisteredWorkspace(page: Page): Promise<void> {
  const workspaceButton = page.getByRole('button', { name: 'Workspace 1', exact: true });
  await expect(workspaceButton).toBeVisible();
  await workspaceButton.click();
  await expect(workspaceButton).toHaveAttribute('aria-pressed', 'true');
}

async function captureOriginalHttpResponse(
  response: Response,
  overallDeadlineAtMs = Date.now() + E2E_PROBE_ATTEMPT_TIMEOUT_MS
) {
  return captureOriginalHostedV1HttpResponse(response, {
    maximumBytes: E2E_PROBE_RESPONSE_MAX_BYTES,
    overallDeadlineAtMs,
  });
}

async function attachOwnerMutationErrorTraceIfPresent(
  testInfo: TestInfo,
  evidenceName: string
): Promise<void> {
  try {
    await testInfo.attach(`${evidenceName}-owner-mutation-error-trace.json`, {
      body: await readFile(fakeRuntimeOwnerMutationErrorTraceFile),
      contentType: 'application/json',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await testInfo.attach(`${evidenceName}-owner-mutation-error-trace-unavailable.json`, {
        body: JSON.stringify({ schemaVersion: 1, kind: 'trace_unavailable' }),
        contentType: 'application/json',
      });
    }
  }
}

async function clickAndExpectCommittedTaskMutation(
  page: Page,
  testInfo: TestInfo,
  evidenceName: string,
  click: () => Promise<void>
): Promise<void> {
  const responsePromise = page
    .waitForResponse(
      (response) => {
        const request = response.request();
        return (
          request.method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/mutations'
        );
      },
      { timeout: 30_000 }
    )
    .then((response) => captureOriginalHttpResponse(response));
  // Keep Playwright from reporting a secondary unhandled rejection if the
  // interaction itself fails before the awaited response arrives.
  void responsePromise.catch(() => undefined);
  try {
    await click();
    const response = await responsePromise;
    await testInfo.attach(`${evidenceName}-task-mutation-response.json`, {
      body: JSON.stringify(response, null, 2),
      contentType: 'application/json',
    });
    expect(response.capture, `${evidenceName} response capture source`).toBe(
      'playwright_original_response'
    );
    expect(response.method, `${evidenceName} task mutation method`).toBe('POST');
    expect(new URL(response.url).pathname, `${evidenceName} task mutation path`).toBe(
      '/api/hosted/v1/team-task-board/mutations'
    );
    expect(response.status, `${evidenceName} task mutation status`).toBe(200);
    expect(JSON.parse(response.rawBody), `${evidenceName} task mutation body`).toMatchObject({
      schemaVersion: 1,
      outcome: 'committed',
      commandId: expect.stringMatching(/^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/u),
      teamId: runtime.teamId,
      sourceGeneration: expect.stringMatching(/^generation_/u),
      revision: expect.stringMatching(/^revision_/u),
      affectedTaskIds: expect.arrayContaining([expect.stringMatching(/^task_[0-9a-f]{32}$/u)]),
    });
  } catch (error) {
    await attachOwnerMutationErrorTraceIfPresent(testInfo, evidenceName);
    throw error;
  }
}

interface Http2ProbeResponse {
  readonly body: string;
  readonly headers: IncomingHttpHeaders & IncomingHttpStatusHeader;
}

function probeBoundedHttp2(input: {
  readonly authority?: string;
  readonly body?: string;
  readonly deadlineBudget?: HostedV1ProbeDeadlineBudget;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly origin: string;
  readonly path: string;
}): Promise<Http2ProbeResponse> {
  const deadlineBudget =
    input.deadlineBudget ??
    createHostedV1ProbeDeadlineBudget({
      overallTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
      perAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
    });
  let attemptTimeoutMs: number;
  try {
    attemptTimeoutMs = deadlineBudget.nextAttemptTimeoutMs();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolveProbe, rejectProbe) => {
    const target = new URL(input.origin);
    if (target.protocol !== 'https:' || !input.path.startsWith('/')) {
      rejectProbe(new Error('hosted_e2e_http2_probe_target_invalid'));
      return;
    }
    const session = connect(target.origin, {
      rejectUnauthorized: false,
      servername: target.hostname,
    });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let responseHeaders: (IncomingHttpHeaders & IncomingHttpStatusHeader) | undefined;
    let settled = false;
    let request: ReturnType<typeof session.request> | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      session.removeListener('error', fail);
      request?.removeListener('error', fail);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      session.destroy();
      rejectProbe(error);
    };
    const timeout = setTimeout(() => {
      fail(new Error('hosted_e2e_http2_probe_timeout'));
    }, attemptTimeoutMs);

    session.once('error', fail);
    try {
      request = session.request({
        ...input.headers,
        ':method': input.method,
        ':path': input.path,
        ':scheme': 'https',
        ':authority': input.authority ?? target.host,
        ...(input.body === undefined
          ? {}
          : { 'content-length': String(Buffer.byteLength(input.body)) }),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.once('response', (headers) => {
      responseHeaders = headers;
      const contentLength = headers['content-length'];
      if (contentLength !== undefined) {
        if (typeof contentLength !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
          fail(new Error('hosted_e2e_probe_content_length_invalid'));
          return;
        }
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > E2E_PROBE_RESPONSE_MAX_BYTES) {
          fail(new Error('hosted_e2e_probe_body_too_large'));
          return;
        }
      }
    });
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > E2E_PROBE_RESPONSE_MAX_BYTES) {
        fail(new Error('hosted_e2e_probe_body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', fail);
    request.once('end', () => {
      if (settled) return;
      if (responseHeaders === undefined) {
        fail(new Error('hosted_e2e_foreign_authority_response_headers_missing'));
        return;
      }
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        fail(new Error('hosted_e2e_probe_body_utf8_invalid'));
        return;
      }
      settled = true;
      cleanup();
      session.close();
      resolveProbe({
        body,
        headers: responseHeaders,
      });
    });
    request.end(input.body);
  });
}

function probeForeignAuthority(
  origin: string,
  cookieHeader: string,
  authority: string,
  deadlineBudget?: HostedV1ProbeDeadlineBudget
): Promise<Http2ProbeResponse> {
  return probeBoundedHttp2({
    authority,
    deadlineBudget,
    headers: { cookie: cookieHeader },
    method: 'GET',
    origin,
    path: '/api/auth/status',
  });
}

async function expectOriginalOidcSessionRevoked(
  testInfo: TestInfo,
  evidenceName: string,
  preLogoutCookieHeader: string
): Promise<void> {
  const response = await probeBoundedHttp2({
    headers: { cookie: preLogoutCookieHeader },
    method: 'GET',
    origin: runtime.origin,
    path: '/api/auth/status',
  });
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    throw new Error('hosted_e2e_oidc_revocation_body_invalid');
  }
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    throw new Error('hosted_e2e_oidc_revocation_body_invalid');
  }
  const body = parsedBody as Record<string, unknown>;
  const evidence = {
    schemaVersion: 1,
    request: { credentialSource: 'pre_logout_session_cookie' },
    response: {
      status: response.headers[':status'] ?? null,
      mode: typeof body.mode === 'string' ? body.mode : null,
      authenticated: typeof body.authenticated === 'boolean' ? body.authenticated : null,
      principalIsNull: body.principal === null,
      csrfTokenIsNull: body.csrfToken === null,
      setCookiePresent: response.headers['set-cookie'] !== undefined,
    },
  };
  await testInfo.attach(`${evidenceName}.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  expect(evidence.response, `${evidenceName} anonymous OIDC evidence`).toEqual({
    status: 200,
    mode: 'oidc',
    authenticated: false,
    principalIsNull: true,
    csrfTokenIsNull: true,
    setCookiePresent: false,
  });
}

test('production HTTPS personal flow remains sandboxed and truthful', async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(12 * 60_000);
  test.skip(runtime.authMode !== 'personal', 'personal-mode scenario only');
  if (runtime.pairingCode === null) throw new Error('hosted_e2e_pairing_code_missing');
  const documentResponse = await page.goto(runtime.origin, {
    waitUntil: 'domcontentloaded',
  });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(documentResponse?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();

  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  await selectRegisteredWorkspace(page);
  const teamButton = await exactRuntimeTeamButton(page);
  await expect(teamButton).toBeVisible();

  const cookies = await context.cookies(runtime.origin);
  for (const name of ['__Host-agent-teams-session', '__Host-agent-teams-device']) {
    const cookie = cookies.find((candidate) => candidate.name === name);
    expect(cookie, `${name} cookie`).toBeDefined();
    expect(cookie).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
  }
  expect(page.url()).not.toContain(runtime.pairingCode);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    runtime.pairingCode
  );

  const projects = await page.evaluate(async () => {
    return window.__hostedE2eProbe('/api/projects', {
      credentials: 'include',
      cache: 'no-store',
    });
  });
  expect(projects.status).toBe(200);
  expect(projects.rawBody).not.toContain('/workspaces/sandbox');
  expect(projects.rawBody).not.toContain(runtime.runtimeWorkspaceId);
  const projectValues = projects.body as {
    id: string;
    name: string;
  }[];
  await writeFile(
    runtime.controllerProjectObservationFile,
    `${JSON.stringify({
      status: 'observed',
      projectCount: projectValues.length,
      exactExpectedPublicProject:
        projectValues.length === 1 &&
        projectValues[0]?.id === runtime.projectWorkspaceId &&
        projectValues[0]?.name === 'sandbox',
      rawRuntimeIdentityAbsent: !projects.rawBody.includes(runtime.runtimeWorkspaceId),
      rawRuntimePathAbsent: !projects.rawBody.includes('/workspaces/sandbox'),
    })}\n`,
    { mode: 0o600 }
  );
  expect(projectValues).toHaveLength(1);
  expect(projectValues[0].id).toBe(runtime.projectWorkspaceId);
  expect(projectValues[0].name).toBe('sandbox');

  const csrfToken = await page.evaluate(async () => {
    const response = await window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    const body = response.body as { csrfToken: string | null };
    return body.csrfToken;
  });
  expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  if (csrfToken === null) throw new Error('hosted_e2e_csrf_token_missing');
  const badOrigin = await probeBoundedHttp2({
    body: JSON.stringify({ global: false }),
    headers: {
      'content-type': 'application/json',
      cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      origin: 'https://attacker.invalid',
      'sec-fetch-site': 'cross-site',
      'x-agent-teams-csrf': csrfToken,
    },
    method: 'POST',
    origin: runtime.origin,
    path: '/api/auth/logout',
  });
  expect(badOrigin.headers[':status']).toBe(403);
  const spoofedForwarding = await page.evaluate(() =>
    window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      headers: {
        forwarded: 'for=203.0.113.7;host=attacker.invalid;proto=http',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'http',
      },
    })
  );
  expect(spoofedForwarding.status).toBe(200);
  expect(spoofedForwarding.body).toMatchObject({ authenticated: true });
  const authenticatedCookies = await context.cookies(runtime.origin);
  const foreignAuthority = await probeForeignAuthority(
    runtime.origin,
    authenticatedCookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    'attacker.invalid'
  );
  expect(foreignAuthority.headers[':status']).toBe(421);
  expect(foreignAuthority.headers['set-cookie']).toBeUndefined();
  expect(foreignAuthority.body).not.toMatch(/"authenticated"\s*:\s*true/u);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await expect(teamButton).toBeVisible();
  const initialTaskBoardResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/page'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  await teamButton.click();
  const initialTaskBoardResponse = await initialTaskBoardResponsePromise;
  const initialTaskBoardPath = new URL(initialTaskBoardResponse.url).pathname;
  await testInfo.attach('initial-task-board-page-response.json', {
    body: JSON.stringify(
      {
        method: initialTaskBoardResponse.method,
        path: initialTaskBoardPath,
        status: initialTaskBoardResponse.status,
        declaredBodyBytes: initialTaskBoardResponse.declaredBodyBytes,
        bodyBytes: initialTaskBoardResponse.bodyBytes,
        rawBody: initialTaskBoardResponse.rawBody,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(initialTaskBoardResponse.status, 'initial task-board page status').toBe(200);
  expect(
    initialTaskBoardResponse.bodyBytes,
    'initial bounded task-board response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  expect(initialTaskBoardResponse.method, 'initial task-board request method').toBe('POST');
  expect(initialTaskBoardPath, 'initial task-board request path').toBe(
    '/api/hosted/v1/team-task-board/page'
  );
  const initialTaskBoard = JSON.parse(initialTaskBoardResponse.rawBody) as {
    budget?: { elapsedMs?: number; timeLimitMs?: number };
    items?: { description?: string; subject?: string }[];
  };
  expect(initialTaskBoard.budget?.timeLimitMs, 'initial task-board page time budget').toBe(5_000);
  expect(initialTaskBoard.budget?.elapsedMs, 'initial task-board elapsed time').toBeLessThan(5_000);
  expect(initialTaskBoard.items, 'initial task-board marker item').toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: 'Marker-owned browser E2E task',
        description: 'Sandbox task-board projection fixture',
      }),
    ])
  );
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('Marker-owned browser E2E task')).toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({
        has: page.getByRole('heading', {
          name: 'Marker-owned browser E2E task',
          exact: true,
        }),
      })
      .locator('p', { hasText: /^Sandbox task-board projection fixture$/u })
  ).toBeVisible();

  const crossWorkspaceDraft = await page.evaluate(
    async ({ forbiddenWorkspaceId, token }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-configuration/draft/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          workspaceId: forbiddenWorkspaceId,
          idempotencyKey: 'idempotency_hosted-v1-e2e-cross-workspace',
          name: 'forbidden-cross-workspace-team',
          members: [{ name: 'lead' }],
        }),
      });
    },
    { forbiddenWorkspaceId: runtime.forbiddenWorkspaceId, token: csrfToken }
  );
  expect(runtime.forbiddenWorkspaceId).not.toBe(runtime.workspaceId);
  expect(crossWorkspaceDraft).toMatchObject({
    status: 403,
    body: {
      schemaVersion: 1,
      kind: 'error',
      error: { code: 'forbidden', reason: 'team_configuration_forbidden' },
      retryable: false,
    },
  });

  const configuredDraft = await page.evaluate(
    async (input) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-configuration/draft/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': input.csrfToken,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          idempotencyKey: 'idempotency_hosted-v1-e2e-draft',
          name: 'browser-created-team',
          members: [{ name: 'lead' }],
        }),
      });
    },
    { ...runtime, csrfToken }
  );
  expect(configuredDraft.status).toBe(201);
  expect(configuredDraft.body).toMatchObject({
    schemaVersion: 1,
    kind: 'created',
    identity: { workspaceId: runtime.workspaceId },
    revision: expect.stringMatching(/^revision_/),
    outcome: 'created',
  });
  const createdIdentity = (
    configuredDraft.body as {
      identity: { workspaceId: string; teamId: string };
      revision: string;
    }
  ).identity;
  const createdRevision = (configuredDraft.body as { revision: string }).revision;
  expect(createdIdentity.teamId).toMatch(/^team_[0-9a-f]{32}$/u);
  expect(createdIdentity.teamId).not.toBe(runtime.teamId);

  const readModels = await page.evaluate(
    async ({ csrfToken: token, identity }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const probe = (input: string, init: RequestInit) =>
        window.__hostedE2eProbe(input, init, { overallDeadlineAtMs });
      const [teams, saved, lifecycle] = await Promise.all([
        probe('/api/teams', { credentials: 'include', cache: 'no-store' }),
        probe('/api/hosted/v1/team-configuration/saved-request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, ...identity }),
        }),
        probe('/api/teams/lifecycle/read', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify({
            schemaVersion: 1,
            cursor: null,
            expectedRevision: null,
          }),
        }),
      ]);
      return { teams, saved, lifecycle };
    },
    { csrfToken, identity: createdIdentity }
  );
  expect(readModels.teams.status).toBe(404);
  expect(readModels.teams.body).toEqual({ error: 'not_found' });
  expect(readModels.saved).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'found',
      draft: {
        ...createdIdentity,
        revision: createdRevision,
        metadata: { name: 'browser-created-team' },
        members: [{ name: 'lead' }],
      },
    },
  });
  expect(readModels.lifecycle.status).toBe(200);
  expect(readModels.lifecycle.body).toMatchObject({
    schemaVersion: 1,
    kind: 'success',
  });
  const lifecycleItems = (
    readModels.lifecycle.body as {
      items: { revision: string; teamId: string; workspaceId: string }[];
    }
  ).items;
  expect(lifecycleItems).toContainEqual(
    expect.objectContaining({
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
    })
  );
  expect(lifecycleItems).not.toContainEqual(expect.objectContaining(createdIdentity));
  const activeTeam = lifecycleItems.find((item) => item.teamId === runtime.teamId);
  expect(activeTeam?.revision).toMatch(/^revision_/u);
  if (activeTeam === undefined) throw new Error('hosted_e2e_active_team_missing');

  const draftCrud = await page.evaluate(
    async ({ csrfToken: token, identity, revision }) => {
      const mutate = async (path: string, body: unknown) => {
        return window.__hostedE2eProbe(path, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify(body),
        });
      };
      const updated = await mutate('/api/hosted/v1/team-configuration/draft/update', {
        schemaVersion: 1,
        ...identity,
        expectedRevision: revision,
        updates: { description: 'Browser E2E draft CRUD proof' },
      });
      const updatedRevision = (updated.body as { draft?: { revision?: string } }).draft?.revision;
      const deleted = await mutate('/api/hosted/v1/team-configuration/draft/delete', {
        schemaVersion: 1,
        ...identity,
        expectedRevision: updatedRevision,
      });
      const savedAfterDelete = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-configuration/saved-request',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, ...identity }),
        }
      );
      return {
        updated,
        deleted,
        savedAfterDelete,
      };
    },
    { csrfToken, identity: createdIdentity, revision: createdRevision }
  );
  expect(draftCrud.updated).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'updated',
      draft: {
        ...createdIdentity,
        metadata: {
          name: 'browser-created-team',
          description: 'Browser E2E draft CRUD proof',
        },
      },
    },
  });
  expect(draftCrud.deleted).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'deleted',
      identity: createdIdentity,
      outcome: 'deleted',
    },
  });
  expect(draftCrud.savedAfterDelete).toMatchObject({
    status: 404,
    body: {
      schemaVersion: 1,
      kind: 'error',
      error: { code: 'not_found', reason: 'team_configuration_not_found' },
      retryable: false,
    },
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await expect(teamButton).toBeVisible();
  await teamButton.click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('No messages yet.')).toBeVisible();
  await page.getByLabel('New task title').fill('Browser-created sandbox task');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-create-task', () =>
    page.getByRole('button', { name: 'Save task' }).click()
  );
  await expect(page.getByText('Browser-created sandbox task')).toBeVisible();
  let browserTask = page.getByRole('listitem').filter({ hasText: 'Browser-created sandbox task' });
  await browserTask
    .getByLabel('Title for Browser-created sandbox task')
    .fill('Updated sandbox task');
  await browserTask
    .getByLabel('Description for Browser-created sandbox task')
    .fill('Owner-bound task mutation E2E details');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-save-details', () =>
    browserTask.getByRole('button', { name: 'Save details' }).click()
  );
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  browserTask = page.getByRole('listitem').filter({ hasText: 'Updated sandbox task' });
  await browserTask.getByLabel('Owner for Updated sandbox task').fill(`member_${'f'.repeat(32)}`);
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-set-owner', () =>
    browserTask.getByRole('button', { name: 'Save owner' }).click()
  );
  await expect(browserTask.getByLabel('Owner for Updated sandbox task')).toHaveValue(
    `member_${'f'.repeat(32)}`
  );
  await browserTask.getByLabel('Owner for Updated sandbox task').fill('');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-clear-owner', () =>
    browserTask.getByRole('button', { name: 'Save owner' }).click()
  );
  await expect(browserTask.getByLabel('Owner for Updated sandbox task')).toHaveValue('');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-next-status', () =>
    browserTask.getByRole('button', { name: 'Next status' }).click()
  );
  await expect(browserTask.getByText('in progress')).toBeVisible();
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-move-up', () =>
    browserTask.getByRole('button', { name: 'Move Updated sandbox task up', exact: true }).click()
  );
  const todoRegion = page.getByRole('region', { name: 'To do', exact: true });
  await expect(todoRegion).toBeVisible();
  await expect
    .poll(async () => todoRegion.getByRole('listitem').first().textContent())
    .toMatch(/^Updated sandbox task/u);
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-move-right', () =>
    browserTask
      .getByRole('button', { name: 'Move Updated sandbox task right', exact: true })
      .click()
  );
  await expect(
    page.getByRole('region', { name: 'In progress' }).getByText('Updated sandbox task')
  ).toBeVisible();
  const replayProbe = await page.evaluate(
    async ({ token, teamId }) => {
      const headers = {
        'content-type': 'application/json',
        'x-agent-teams-csrf': token,
      };
      const pageResponse = await window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
      const board = pageResponse.body as {
        sourceGeneration: string;
        revision: string;
        items: { taskId: string; subject: string }[];
      };
      const task = board.items.find((item) => item.subject === 'Updated sandbox task');
      if (!task) throw new Error('hosted_e2e_mutated_task_missing');
      const command = {
        schemaVersion: 1,
        kind: 'update_status',
        commandId: 'command_hosted-v1-task-replay',
        idempotencyKey: 'idempotency_hosted-v1-task-replay',
        teamId,
        expectedSourceGeneration: board.sourceGeneration,
        expectedRevision: board.revision,
        taskId: task.taskId,
        status: 'completed',
      };
      const mutate = async (body: object) => {
        return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/mutations', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(body),
        });
      };
      return {
        command,
        committed: await mutate(command),
        replayed: await mutate(command),
        mismatch: await mutate({ ...command, status: 'pending' }),
      };
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  expect(replayProbe.committed).toMatchObject({
    status: 200,
    body: { outcome: 'committed' },
  });
  expect(replayProbe.replayed).toMatchObject({
    status: 200,
    body: { outcome: 'idempotent_replay' },
  });
  expect(replayProbe.mismatch).toMatchObject({
    status: 409,
    body: { error: { reason: 'idempotency_mismatch' } },
  });
  await restartHostedV1LifecycleOwner({ compose });
  const requestPostRestartReplay = (timeoutMs: number, overallDeadlineAtMs: number) =>
    page.evaluate(
      async ({ token, command, requestTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/mutations',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify(command),
              },
              { attemptTimeoutMs: requestTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        token: csrfToken,
        command: replayProbe.command,
        requestTimeoutMs: timeoutMs,
        overallDeadlineAtMs,
      }
    );
  const postRestartReplayDeadline = Date.now() + 20_000;
  let postRestartReplay = await requestPostRestartReplay(2_000, postRestartReplayDeadline);
  while (
    (postRestartReplay.status !== 200 ||
      (postRestartReplay.body as { outcome?: string } | null)?.outcome !== 'idempotent_replay') &&
    Date.now() < postRestartReplayDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, postRestartReplayDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= postRestartReplayDeadline) break;
    postRestartReplay = await requestPostRestartReplay(
      Math.max(1, Math.min(2_000, postRestartReplayDeadline - Date.now())),
      postRestartReplayDeadline
    );
  }
  await testInfo.attach('post-restart-replay-readiness-last-response.json', {
    body: JSON.stringify(postRestartReplay, null, 2),
    contentType: 'application/json',
  });
  expect(postRestartReplay, 'last post-restart replay readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: { outcome: 'idempotent_replay' },
  });
  const interruptedCommand = await page.evaluate(
    async ({ token, teamId }) => {
      const response = await window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
      const board = response.body as { sourceGeneration: string; revision: string };
      return {
        schemaVersion: 1,
        kind: 'create_task',
        commandId: 'command_hosted-v1-task-interrupted-wal',
        idempotencyKey: 'idempotency_hosted-v1-task-interrupted-wal',
        teamId,
        expectedSourceGeneration: board.sourceGeneration,
        expectedRevision: board.revision,
        subject: 'Recovered interrupted WAL task',
        description: 'Forward-recovered after the first of two target renames',
        status: 'pending',
        ownerId: `member_${'f'.repeat(32)}`,
        column: 'todo',
        order: 0,
      };
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  const fakeRuntimeDirectory = resolve(runtime.fakeRuntimeStateFile, '..');
  const taskWalPath = resolve(fakeRuntimeDirectory, 'task-mutation.wal.json');
  const taskCrashPath = resolve(fakeRuntimeDirectory, 'task-mutation.crash.json');
  await writeFile(
    taskCrashPath,
    `${JSON.stringify({
      schemaVersion: 1,
      commandId: interruptedCommand.commandId,
      afterRenames: 1,
    })}\n`,
    { mode: 0o600 }
  );
  await chown(taskCrashPath, 1000, 1000);
  const interruptedAttempt = await page.evaluate(
    async ({ token, command }) => {
      try {
        const response = await fetch('/api/hosted/v1/team-task-board/mutations', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify(command),
        });
        return { networkError: false, status: response.status };
      } catch {
        return { networkError: true, status: null };
      }
    },
    { token: csrfToken, command: interruptedCommand }
  );
  expect(
    interruptedAttempt.networkError ||
      interruptedAttempt.status === 502 ||
      interruptedAttempt.status === 503
  ).toBe(true);
  await expect
    .poll(() => compose('ps', '--status', 'exited', '--quiet', 'fake-runtime'))
    .not.toBe('');
  const interruptedWal = JSON.parse(await readFile(taskWalPath, 'utf8')) as {
    schemaVersion: number;
    commandId: string;
    writes: [string, string][];
  };
  expect(interruptedWal).toMatchObject({
    schemaVersion: 3,
    commandId: interruptedCommand.commandId,
  });
  expect(interruptedWal.writes).toHaveLength(2);
  const interruptedState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    taskLedger?: { key: string }[];
  };
  expect(
    (interruptedState.taskLedger ?? []).some((entry) =>
      entry.key.endsWith(`\u0000${interruptedCommand.idempotencyKey}`)
    )
  ).toBe(false);
  const recoveredWalOwnerOperations: Array<'task_board_read' | 'task_board_mutation'> = [];
  const observeRecoveredWalOwnerOperation = (request: Request): void => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/hosted/v1/team-task-board/page') {
      recoveredWalOwnerOperations.push('task_board_read');
    } else if (path === '/api/hosted/v1/team-task-board/mutations') {
      recoveredWalOwnerOperations.push('task_board_mutation');
    }
  };
  page.on('request', observeRecoveredWalOwnerOperation);
  await restartHostedV1LifecycleOwner({ compose });
  // The first owner operation after restart is deliberately a read. It proves startup recovery
  // made the interrupted postimage visible and removed the WAL before any mutation replay can
  // influence either observation.
  const requestRecoveredBoard = (timeoutMs: number, overallDeadlineAtMs: number) =>
    page.evaluate(
      async ({ token, teamId, timeoutMs: attemptTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false as const,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/page',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify({
                  schemaVersion: 1,
                  teamId,
                  cursor: null,
                  expectedSourceGeneration: null,
                  limit: 100,
                }),
              },
              { attemptTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true as const,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, teamId: runtime.teamId, timeoutMs, overallDeadlineAtMs }
    );
  const recoveredBoardDeadline = Date.now() + 20_000;
  let recoveredBoardProbe: Awaited<ReturnType<typeof requestRecoveredBoard>> | null = null;
  while (Date.now() < recoveredBoardDeadline) {
    recoveredBoardProbe = await requestRecoveredBoard(
      Math.max(1, Math.min(2_000, recoveredBoardDeadline - Date.now())),
      recoveredBoardDeadline
    );
    if (!recoveredBoardProbe.networkError && recoveredBoardProbe.status === 200) break;
    const retryDelayMs = Math.min(250, Math.max(0, recoveredBoardDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, retryDelayMs));
  }
  await testInfo.attach('recovered-wal-cold-first-board-response.json', {
    body: JSON.stringify(recoveredBoardProbe, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredBoardProbe, 'cold first recovered WAL board response').toMatchObject({
    networkError: false,
    status: 200,
  });
  const recoveredBoardBody = recoveredBoardProbe?.body as {
    revision?: unknown;
    items?: Array<{ subject?: unknown; ownerId?: unknown }>;
  } | null;
  expect(recoveredBoardBody).toMatchObject({
    revision: expect.stringMatching(/^revision_/u),
    items: expect.arrayContaining([
      expect.objectContaining({
        subject: 'Recovered interrupted WAL task',
        ownerId: `member_${'f'.repeat(32)}`,
      }),
    ]),
  });
  const recoveredRevision = recoveredBoardBody?.revision;
  expect(recoveredRevision).toEqual(expect.stringMatching(/^revision_/u));
  const recoveredWalAbsence = await readFile(taskWalPath, 'utf8').then(
    () => ({ code: null }),
    (error: NodeJS.ErrnoException) => ({ code: error.code ?? null })
  );
  expect(recoveredWalAbsence).toEqual({ code: 'ENOENT' });
  expect(recoveredWalOwnerOperations.length).toBeGreaterThan(0);
  expect(recoveredWalOwnerOperations.every((operation) => operation === 'task_board_read')).toBe(
    true
  );

  const requestRecoveredWalMutation = (
    command: typeof interruptedCommand,
    timeoutMs: number,
    overallDeadlineAtMs: number
  ) =>
    page.evaluate(
      async ({ token, command, requestTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/mutations',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify(command),
              },
              { attemptTimeoutMs: requestTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, command, requestTimeoutMs: timeoutMs, overallDeadlineAtMs }
    );
  const recoveryDeadline = Date.now() + 20_000;
  let recoveredReplay = await requestRecoveredWalMutation(
    interruptedCommand,
    2_000,
    recoveryDeadline
  );
  while (
    (recoveredReplay.status !== 200 ||
      (recoveredReplay.body as { outcome?: string } | null)?.outcome !== 'idempotent_replay') &&
    Date.now() < recoveryDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, recoveryDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= recoveryDeadline) break;
    recoveredReplay = await requestRecoveredWalMutation(
      interruptedCommand,
      Math.max(1, Math.min(2_000, recoveryDeadline - Date.now())),
      recoveryDeadline
    );
  }
  await testInfo.attach('recovered-wal-readiness-last-response.json', {
    body: JSON.stringify(recoveredReplay, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredReplay, 'last WAL recovery readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: { outcome: 'idempotent_replay', revision: recoveredRevision },
  });
  const recoveredMismatchDeadline = Date.now() + 5_000;
  const recoveredMismatch = await requestRecoveredWalMutation(
    { ...interruptedCommand, description: 'mismatched replay' },
    Math.max(1, recoveredMismatchDeadline - Date.now()),
    recoveredMismatchDeadline
  );
  await testInfo.attach('recovered-wal-mismatch-response.json', {
    body: JSON.stringify(recoveredMismatch, null, 2),
    contentType: 'application/json',
  });
  const recoveredWalProbe = { replay: recoveredReplay, mismatch: recoveredMismatch };
  expect(recoveredWalProbe).toMatchObject({
    replay: { status: 200, body: { outcome: 'idempotent_replay' } },
    mismatch: { status: 409, body: { error: { reason: 'idempotency_mismatch' } } },
  });
  page.off('request', observeRecoveredWalOwnerOperation);
  expect(recoveredWalOwnerOperations[0]).toBe('task_board_read');
  expect(recoveredWalOwnerOperations.indexOf('task_board_mutation')).toBeGreaterThan(0);
  await testInfo.attach('recovered-wal-cold-read-ordering-proof.json', {
    body: JSON.stringify({
      observedOwnerOperations: recoveredWalOwnerOperations,
      proofOrder: ['task_board_read', 'wal_absence', 'mutation_replay_and_mismatch'],
      coldBoardStatus: recoveredBoardProbe?.status,
      recoveredRevision,
      walReadErrorCode: recoveredWalAbsence.code,
      replayStatus: recoveredReplay.status,
      mismatchStatus: recoveredMismatch.status,
    }),
    contentType: 'application/json',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  const recoveredUiBoardDeadline = Date.now() + 25_000;
  const recoveredUiBoardAttempts: Array<{
    bodyBytes: number;
    rawBody: string;
    status: number;
  }> = [];
  const clickAndCaptureRecoveredUiBoard = async (click: () => Promise<void>) => {
    const remainingMs = Math.max(1, recoveredUiBoardDeadline - Date.now());
    const responsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/page',
        { timeout: remainingMs }
      )
      .then((response) => captureOriginalHttpResponse(response, recoveredUiBoardDeadline));
    void responsePromise.catch(() => undefined);
    await click();
    const { status, bodyBytes, rawBody } = await responsePromise;
    const attempt = { status, bodyBytes, rawBody };
    recoveredUiBoardAttempts.push(attempt);
    return attempt;
  };
  let recoveredUiBoardAttempt = await clickAndCaptureRecoveredUiBoard(() => teamButton.click());
  while (recoveredUiBoardAttempt.status === 503 && Date.now() < recoveredUiBoardDeadline) {
    const retryDelayMs = Math.min(250, Math.max(0, recoveredUiBoardDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= recoveredUiBoardDeadline) break;
    recoveredUiBoardAttempt = await clickAndCaptureRecoveredUiBoard(() =>
      page.getByRole('button', { name: 'Refresh task board', exact: true }).click()
    );
  }
  await testInfo.attach('recovered-wal-ui-board-readiness-responses.json', {
    body: JSON.stringify(recoveredUiBoardAttempts, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredUiBoardAttempt.status, 'recovered WAL UI task-board status').toBe(200);
  expect(
    recoveredUiBoardAttempt.bodyBytes,
    'recovered bounded board response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  const personalMessageReadinessDeadline = Date.now() + 25_000;
  const personalMessageReadinessAttempts: Array<{
    advertisement: string | null;
    bodyBytes: number;
    rawBody: string;
    status: number;
  }> = [];
  let personalMessageReady = false;
  while (!personalMessageReady && Date.now() < personalMessageReadinessDeadline) {
    const remainingMs = Math.max(1, personalMessageReadinessDeadline - Date.now());
    if (remainingMs < 1_000) break;
    const responsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-messages/page',
        { timeout: remainingMs }
      )
      .then(async (response) => ({
        advertisement: response.headers()['x-agent-teams-team-message-send-advertisement'] ?? null,
        captured: await captureOriginalHttpResponse(response, personalMessageReadinessDeadline),
      }));
    void responsePromise.catch(() => undefined);
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    const { advertisement, captured } = await responsePromise;
    personalMessageReadinessAttempts.push({
      advertisement,
      bodyBytes: captured.bodyBytes,
      rawBody: captured.rawBody,
      status: captured.status,
    });
    personalMessageReady = captured.status === 200 && advertisement === 'enabled';
    if (!personalMessageReady && Date.now() < personalMessageReadinessDeadline) {
      await page.waitForTimeout(
        Math.min(250, Math.max(1, personalMessageReadinessDeadline - Date.now()))
      );
    }
  }
  await testInfo.attach('personal-owner-message-readiness-responses.json', {
    body: JSON.stringify(personalMessageReadinessAttempts, null, 2),
    contentType: 'application/json',
  });
  expect(
    personalMessageReady,
    `message send capability became authoritative; last responses=${JSON.stringify(
      personalMessageReadinessAttempts.slice(-3)
    )}`
  ).toBe(true);
  await expect(page.getByLabel('New message')).toBeVisible();
  const personalMessage = 'sandbox capability prompt/message probe for the active team';
  const personalMessageResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-messages/send'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  void personalMessageResponsePromise.catch(() => undefined);
  await page.getByLabel('New message').fill(personalMessage);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const personalMessageResponse = await personalMessageResponsePromise;
  await testInfo.attach('personal-owner-message-send-original-response.json', {
    body: JSON.stringify(personalMessageResponse, null, 2),
    contentType: 'application/json',
  });
  expect(personalMessageResponse.capture).toBe('playwright_original_response');
  expect(personalMessageResponse.method).toBe('POST');
  expect(new URL(personalMessageResponse.url).pathname).toBe('/api/hosted/v1/team-messages/send');
  expect(personalMessageResponse.status).toBe(200);
  expect(personalMessageResponse.bodyBytes).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  const personalMessageBody = JSON.parse(personalMessageResponse.rawBody) as {
    kind: string;
    receipt: {
      schemaVersion: number;
      teamId: string;
      messageId: string;
      clientMessageId: string;
      persistence: string;
      runtimeDelivery: string;
    };
  };
  expect(personalMessageBody).toEqual({
    kind: 'persisted',
    receipt: {
      schemaVersion: 1,
      teamId: runtime.teamId,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
      clientMessageId: expect.stringMatching(/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
      persistence: 'durable',
      runtimeDelivery: 'delivered',
    },
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({
      hasText: personalMessage,
    })
  ).toBeVisible();
  const personalMessageReplayAndPage = await page.evaluate(
    async ({ token, teamId, text, clientMessageId }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const replay = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/send',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            clientMessageId,
            text,
          }),
        },
        { overallDeadlineAtMs }
      );
      const pageResponse = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/page',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: 50,
          }),
        },
        { overallDeadlineAtMs }
      );
      return { replay, page: pageResponse };
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      text: personalMessage,
      clientMessageId: personalMessageBody.receipt.clientMessageId,
    }
  );
  expect(personalMessageReplayAndPage.replay.status).toBe(200);
  expect(personalMessageReplayAndPage.replay.body).toEqual({
    ...personalMessageBody,
    kind: 'idempotent_replay',
    receipt: {
      ...personalMessageBody.receipt,
      runtimeDelivery: 'operator_required',
    },
  });
  expect(JSON.parse(personalMessageReplayAndPage.replay.rawBody)).toEqual(
    personalMessageReplayAndPage.replay.body
  );
  expect(personalMessageReplayAndPage.page.status).toBe(200);
  expect(
    (
      personalMessageReplayAndPage.page.body as {
        messages: Array<{ messageId: string; text: string }>;
      }
    ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
  ).toEqual([
    expect.objectContaining({
      messageId: personalMessageBody.receipt.messageId,
      text: personalMessage,
    }),
  ]);
  const personalMessageState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    messageLedger: Array<{
      clientMessageId: string;
      delivered: boolean;
      messageId: string;
    }>;
  };
  expect(
    personalMessageState.messageLedger.filter(
      (entry) => entry.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      delivered: true,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
    }),
  ]);
  const personalInboxPath = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'teams',
    runtime.teamName,
    'inboxes',
    'team-lead.json'
  );
  const personalInboxRows = JSON.parse(await readFile(personalInboxPath, 'utf8')) as Array<{
    hostedOperation?: { clientMessageId?: string };
    hostedDelivery?: { acknowledgement?: string };
  }>;
  expect(
    personalInboxRows.filter(
      (row) => row.hostedOperation?.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      hostedDelivery: expect.objectContaining({ acknowledgement: 'durable' }),
    }),
  ]);
  const personalInboxAfterDeliveryBytes = await readFile(personalInboxPath, 'utf8');

  const eventRequestHeaders: Record<string, string>[] = [];
  const eventRequestUrls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/hosted/v1/events' && url.searchParams.get('e2e') === 'resume') {
      eventRequestUrls.push(request.url());
      void request
        .allHeaders()
        .then((headers) => eventRequestHeaders.push(headers))
        .catch(() => undefined);
    }
  });
  const initialEventStreamResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname === '/api/hosted/v1/events' &&
      url.searchParams.get('e2e') === 'resume'
    );
  });
  void initialEventStreamResponsePromise.catch(() => undefined);
  await page.evaluate((cursor) => {
    const state = {
      source: null as EventSource | null,
      opens: 0,
      ids: [] as string[],
      cursor,
      reconnectTimer: null as number | null,
      closed: false,
    };
    const connect = () => {
      if (state.closed) return;
      const source = new EventSource(
        `/api/hosted/v1/events?after=${encodeURIComponent(state.cursor)}&e2e=resume`
      );
      state.source = source;
      source.onopen = () => {
        if (state.source === source) state.opens += 1;
      };
      source.onerror = () => {
        if (state.closed || state.source !== source) return;
        source.close();
        state.reconnectTimer = window.setTimeout(connect, 250);
      };
      source.addEventListener('coordination_event', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { eventType?: unknown };
        if (data.eventType !== 'team-lifecycle.run-accepted') return;
        const eventCursor = (event as MessageEvent).lastEventId;
        state.ids.push(eventCursor);
        state.cursor = eventCursor;
      });
    };
    connect();
    (window as typeof window & { __hostedE2eSse?: typeof state }).__hostedE2eSse = state;
  }, runtime.eventCursor);
  const initialEventStreamResponse = await initialEventStreamResponsePromise;
  const initialEventStreamStatus = initialEventStreamResponse.status();
  await testInfo.attach('initial-event-stream-response.json', {
    body: JSON.stringify(
      {
        status: initialEventStreamStatus,
        requestHeaders: await initialEventStreamResponse.request().allHeaders(),
        responseHeaders: await initialEventStreamResponse.allHeaders(),
        failureBody: null,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(initialEventStreamStatus, 'initial coordination event stream status').toBe(200);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & {
            __hostedE2eSse?: { opens: number; ids: string[] };
          }
        ).__hostedE2eSse;
        return state ? { opens: state.opens, events: state.ids.length } : null;
      })
    )
    .toEqual({ opens: 1, events: 0 });

  const lifecycleLaunch = await page.evaluate(
    async (input) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': input.csrfToken,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-e2e',
          idempotencyKey: 'idempotency_hosted-v1-e2e',
          workspaceId: input.identity.workspaceId,
          teamId: input.identity.teamId,
          expectedRevision: input.revision,
        }),
      });
    },
    { csrfToken, identity: activeTeam, revision: activeTeam.revision }
  );
  await testInfo.attach('personal-lifecycle-launch-response.json', {
    body: JSON.stringify(lifecycleLaunch, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('personal-lifecycle-launch-runtime-state.json', {
    body: await readFile(runtime.fakeRuntimeStateFile),
    contentType: 'application/json',
  });
  await testInfo.attach('personal-lifecycle-launch-runtime-trace.json', {
    body: await readFile(runtime.fakeRuntimeLifecycleTraceFile),
    contentType: 'application/json',
  });
  expect(lifecycleLaunch.status).toBe(202);
  expect(lifecycleLaunch.body).toMatchObject({
    schemaVersion: 1,
    kind: 'accepted',
    action: 'launch',
    teamId: runtime.teamId,
    workspaceId: runtime.workspaceId,
    resourceRevision: expect.stringMatching(/^revision_/u),
    runId: expect.stringMatching(/^run_/u),
  });
  const lifecycleLaunchBody = lifecycleLaunch.body as {
    commandId: string;
    resourceRevision: string;
    runId: string;
  };
  expect(lifecycleLaunchBody.resourceRevision).not.toBe(activeTeam.revision);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (
            window as typeof window & {
              __hostedE2eSse?: { opens: number; ids: string[] };
            }
          ).__hostedE2eSse;
          return Boolean(state && state.opens >= 1 && state.ids.length === 1);
        }),
      { timeout: EXTERNAL_COORDINATION_EVENT_REPLAY_TIMEOUT_MS }
    )
    .toBe(true);
  const firstDeliveredCursor = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __hostedE2eSse?: { ids: string[] };
      }
    ).__hostedE2eSse;
    return state?.ids[0] ?? null;
  });
  expect(firstDeliveredCursor).toMatch(/^cev1\./);
  expect(firstDeliveredCursor).not.toBe(runtime.eventCursor);

  const lifecycleCommand = (
    action: 'recover' | 'stop',
    sequence: number,
    expectedRevision: string
  ) => ({
    schemaVersion: 1 as const,
    commandId: `lifecycle-command_hosted-v1-e2e-${action}-${sequence}`,
    idempotencyKey: `idempotency_hosted-v1-e2e-${action}-${sequence}`,
    workspaceId: activeTeam.workspaceId,
    teamId: activeTeam.teamId,
    runId: lifecycleLaunchBody.runId,
    expectedRevision,
  });
  const requestLifecycle = (
    action: 'recover' | 'stop',
    command: ReturnType<typeof lifecycleCommand>
  ) =>
    page.evaluate(
      async (input) => {
        return window.__hostedE2eProbe(`/api/hosted/v1/team-lifecycle/${input.action}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': input.csrfToken,
          },
          body: JSON.stringify(input.command),
        });
      },
      {
        action,
        csrfToken,
        command,
      }
    );
  const firstStopCommand = lifecycleCommand('stop', 1, lifecycleLaunchBody.resourceRevision);
  const firstStop = await requestLifecycle('stop', firstStopCommand);
  expect(firstStop).toMatchObject({
    status: 202,
    body: {
      action: 'stop',
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const firstStopRevision = String(
    (firstStop.body as { resourceRevision: string }).resourceRevision
  );
  expect(firstStopRevision).not.toBe(lifecycleLaunchBody.resourceRevision);
  const recoveryCommand = lifecycleCommand('recover', 2, firstStopRevision);
  const recovery = await requestLifecycle('recover', recoveryCommand);
  expect(recovery).toMatchObject({
    status: 202,
    body: {
      action: 'recover',
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const recoveryRevision = String((recovery.body as { resourceRevision: string }).resourceRevision);
  expect(recoveryRevision).not.toBe(firstStopRevision);
  const finalStopCommand = lifecycleCommand('stop', 3, recoveryRevision);
  const interceptedFinalStopResponses: Array<{ status: number; body: unknown }> = [];
  const finalStopRoute = '**/api/hosted/v1/team-lifecycle/stop';
  let forwardingFinalStopProbe = false;
  await page.route(finalStopRoute, async (route) => {
    const body = route.request().postDataJSON() as { commandId?: unknown };
    if (body.commandId !== finalStopCommand.commandId || forwardingFinalStopProbe) {
      await route.fallback();
      return;
    }
    forwardingFinalStopProbe = true;
    try {
      const upstream = await page.evaluate(
        ({ token, command, overallDeadlineAtMs }) =>
          window.__hostedE2eProbe(
            '/api/hosted/v1/team-lifecycle/stop',
            {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/json',
                'x-agent-teams-csrf': token,
              },
              body: JSON.stringify(command),
            },
            { overallDeadlineAtMs }
          ),
        {
          token: csrfToken,
          command: finalStopCommand,
          overallDeadlineAtMs: Date.now() + E2E_PROBE_ATTEMPT_TIMEOUT_MS,
        }
      );
      interceptedFinalStopResponses.push({ status: upstream.status, body: upstream.body });
    } finally {
      forwardingFinalStopProbe = false;
      await route.abort('failed');
    }
  });
  let lostFinalStopAttempt: {
    networkError: boolean;
    status: number | null;
    body: unknown;
    error?: string;
  };
  try {
    lostFinalStopAttempt = await page.evaluate(
      async ({ token, command }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/stop', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/json',
                'x-agent-teams-csrf': token,
              },
              body: JSON.stringify(command),
            })),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, command: finalStopCommand }
    );
  } finally {
    await page.unroute(finalStopRoute);
  }
  expect(lostFinalStopAttempt).toMatchObject({ networkError: true, status: null });
  expect(interceptedFinalStopResponses).toHaveLength(1);
  const interceptedFinalStop = interceptedFinalStopResponses[0]!;
  expect(interceptedFinalStop).toMatchObject({
    status: 202,
    body: {
      action: 'stop',
      commandId: finalStopCommand.commandId,
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const finalStopRevision = String(
    (interceptedFinalStop.body as { resourceRevision: string }).resourceRevision
  );
  expect(finalStopRevision).not.toBe(recoveryRevision);
  await testInfo.attach('personal-lifecycle-response-loss.json', {
    body: JSON.stringify(
      {
        command: finalStopCommand,
        clientAttempt: lostFinalStopAttempt,
        upstream: interceptedFinalStop,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  const runtimeState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: { teamId: string; runId: string }[];
    commands: { action: string; teamId: string; runId: string }[];
    eventIds: string[];
  };
  expect(runtimeState.commands.map((command) => command.action)).toEqual([
    'launch',
    'stop',
    'recover',
    'stop',
  ]);
  expect(runtimeState.commands.every((command) => command.teamId === runtime.teamId)).toBe(true);
  expect(
    runtimeState.commands.every((command) => command.runId === lifecycleLaunchBody.runId)
  ).toBe(true);
  expect(runtimeState.eventIds).toHaveLength(1);
  expect(runtimeState.activeRuns).toEqual([]);

  await restartHostedV1LifecycleOwner({ compose });
  const postRestartSessionCookies = (await context.cookies(runtime.origin)).filter(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  );
  expect(postRestartSessionCookies, 'current post-restart session cookie').toHaveLength(1);
  const postRestartSessionCookie = postRestartSessionCookies[0];
  if (postRestartSessionCookie === undefined) {
    throw new Error('hosted_e2e_post_restart_session_cookie_missing');
  }
  const postRestartSessionCookieHeader = `${postRestartSessionCookie.name}=${postRestartSessionCookie.value}`;
  const requestPostRestartLifecycle = (
    body: string,
    deadlineBudget: HostedV1ProbeDeadlineBudget
  ) => {
    return probeBoundedHttp2({
      body,
      deadlineBudget,
      headers: {
        'content-type': 'application/json',
        cookie: postRestartSessionCookieHeader,
        origin: runtime.origin,
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': csrfToken,
      },
      method: 'POST',
      origin: runtime.origin,
      path: '/api/hosted/v1/team-lifecycle/stop',
    }).then(
      (response) => {
        let body: unknown = response.body;
        try {
          body = JSON.parse(response.body);
        } catch {
          // Preserve the bounded raw response so the strict receipt assertion fails truthfully.
        }
        return {
          networkError: false as const,
          status: response.headers[':status'] ?? null,
          rawBody: response.body,
          body,
        };
      },
      (error) => ({
        networkError: true as const,
        status: null,
        rawBody: null,
        body: null,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  };
  const postLifecycleRecoveryBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 20_000,
    perAttemptTimeoutMs: 2_000,
  });
  const finalStopReplayBody = JSON.stringify(finalStopCommand);
  let postLifecycleReplay = await requestPostRestartLifecycle(
    finalStopReplayBody,
    postLifecycleRecoveryBudget
  );
  while (
    (postLifecycleReplay.status !== 200 ||
      (postLifecycleReplay.body as { kind?: string } | null)?.kind !== 'idempotent_replay') &&
    postLifecycleRecoveryBudget.remainingMs() > 0
  ) {
    let retryDelayMs: number;
    try {
      retryDelayMs = postLifecycleRecoveryBudget.clipRetryDelayMs(250);
    } catch {
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, retryDelayMs));
    if (postLifecycleRecoveryBudget.remainingMs() <= 0) break;
    postLifecycleReplay = await requestPostRestartLifecycle(
      finalStopReplayBody,
      postLifecycleRecoveryBudget
    );
  }
  await testInfo.attach('post-lifecycle-replay-readiness-last-response.json', {
    body: JSON.stringify(postLifecycleReplay, null, 2),
    contentType: 'application/json',
  });
  expect(postLifecycleReplay, 'last post-lifecycle replay readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'idempotent_replay',
      action: 'stop',
      commandId: finalStopCommand.commandId,
      workspaceId: runtime.workspaceId,
      teamId: runtime.teamId,
      runId: lifecycleLaunchBody.runId,
      resourceRevision: finalStopRevision,
    },
  });
  expect({ ...(postLifecycleReplay.body as object), kind: 'accepted' }).toEqual(
    interceptedFinalStop.body
  );
  const lifecycleMismatchCommand = {
    ...finalStopCommand,
    expectedRevision: finalStopRevision,
  };
  const lifecycleMismatchBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 5_000,
    perAttemptTimeoutMs: 5_000,
  });
  const postLifecycleMismatch = await requestPostRestartLifecycle(
    JSON.stringify(lifecycleMismatchCommand),
    lifecycleMismatchBudget
  );
  expect(postLifecycleMismatch).toMatchObject({
    networkError: false,
    status: 409,
    body: {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    },
  });
  const postRestartLifecycleState = JSON.parse(
    await readFile(runtime.fakeRuntimeStateFile, 'utf8')
  ) as { commands: { commandId: string }[] };
  expect(
    postRestartLifecycleState.commands.filter(
      (command) => command.commandId === finalStopCommand.commandId
    )
  ).toHaveLength(1);
  await testInfo.attach('post-restart-identical-lifecycle-replay.json', {
    body: JSON.stringify(
      {
        command: finalStopCommand,
        interceptedResponse: interceptedFinalStop,
        replayResponse: postLifecycleReplay,
        mismatchResponse: postLifecycleMismatch,
        matchingEffectCount: postRestartLifecycleState.commands.filter(
          (command) => command.commandId === finalStopCommand.commandId
        ).length,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });

  const expectInstanceLockRejection = async () => {
    await expect(
      compose(
        'exec',
        '-T',
        'hosted-controller',
        '/usr/local/bin/hosted-entrypoint',
        '/usr/local/bin/node',
        '/app/dist-standalone/index.cjs'
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('instance_lock:') });
  };
  await expectInstanceLockRejection();

  const controllerId = (await compose('ps', '--quiet', 'hosted-controller')).trim();
  expect(controllerId).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    (
      await docker(
        'inspect',
        '--format',
        '{{ index .Config.Labels "com.docker.compose.project" }}',
        controllerId
      )
    ).trim()
  ).toBe(composeProject);
  const controllerProcesses = await docker('top', controllerId, '-eo', 'pid,args');
  const controllerProcess = controllerProcesses
    .split('\n')
    .find((line) => /\bnode\b.*\bdist-standalone\/index\.cjs\b/u.test(line));
  expect(controllerProcess, controllerProcesses).toBeDefined();
  const controllerPid = Number(controllerProcess?.trim().split(/\s+/u)[0]);
  expect(Number.isSafeInteger(controllerPid) && controllerPid > 1).toBe(true);

  process.kill(controllerPid, 'SIGTERM');
  await expect
    .poll(async () => compose('ps', '--status', 'exited', '--quiet', 'hosted-controller'))
    .not.toBe('');
  const shutdownLogs = await compose('logs', '--no-color', 'hosted-controller');
  const shutdownState = JSON.parse(
    await docker('inspect', '--format', '{{json .State}}', controllerId)
  ) as { Error: string; ExitCode: number; OOMKilled: boolean };
  await testInfo.attach('personal-controller-shutdown.json', {
    body: JSON.stringify({ logs: shutdownLogs, state: shutdownState }, null, 2),
    contentType: 'application/json',
  });
  expect(shutdownState).toMatchObject({ Error: '', ExitCode: 0, OOMKilled: false });
  await restartHostedV1LifecycleOwner({ compose });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (
            window as typeof window & {
              __hostedE2eSse?: { opens: number; ids: string[] };
            }
          ).__hostedE2eSse;
          return state?.opens ?? 0;
        }),
      { timeout: EXTERNAL_COORDINATION_EVENT_REPLAY_TIMEOUT_MS }
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => eventRequestHeaders.length, {
      timeout: EXTERNAL_COORDINATION_EVENT_REPLAY_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(2);
  const resumeHeaders = eventRequestHeaders;
  expect(resumeHeaders.length).toBeGreaterThanOrEqual(2);
  expect(resumeHeaders[0]['last-event-id']).toBeUndefined();
  expect(
    eventRequestUrls
      .slice(1)
      .some((url) => new URL(url).searchParams.get('after') === firstDeliveredCursor)
  ).toBe(true);
  await testInfo.attach('personal-event-stream-reconnect.json', {
    body: JSON.stringify(
      {
        requestUrls: eventRequestUrls,
        requestHeaders: resumeHeaders,
        state: await page.evaluate(() => {
          const state = (
            window as typeof window & {
              __hostedE2eSse?: { opens: number; ids: string[]; cursor: string };
            }
          ).__hostedE2eSse;
          return state ? { opens: state.opens, ids: state.ids, cursor: state.cursor } : null;
        }),
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(
    await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __hostedE2eSse?: { ids: string[] };
        }
      ).__hostedE2eSse;
      return state?.ids ?? [];
    })
  ).toEqual([firstDeliveredCursor]);
  await expectInstanceLockRejection();
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __hostedE2eSse?: {
          source: EventSource | null;
          reconnectTimer: number | null;
          closed: boolean;
        };
      }
    ).__hostedE2eSse;
    if (!state) return;
    state.closed = true;
    if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer);
    state.source?.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await teamButton.click();
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  const postRestartRuntimeBeforeBytes = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const requestPostRestartPersonalMessage = (
    text: string,
    attemptTimeoutMs: number,
    overallDeadlineAtMs: number
  ) =>
    page.evaluate(
      async ({ token, teamId, clientMessageId, text, attemptTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false as const,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-messages/send',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify({
                  schemaVersion: 1,
                  teamId,
                  clientMessageId,
                  text,
                }),
              },
              { attemptTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true as const,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        token: csrfToken,
        teamId: runtime.teamId,
        clientMessageId: personalMessageBody.receipt.clientMessageId,
        text,
        attemptTimeoutMs,
        overallDeadlineAtMs,
      }
    );
  const personalMessageRecoveryDeadline = Date.now() + 20_000;
  let postRestartPersonalReplay = await requestPostRestartPersonalMessage(
    personalMessage,
    2_000,
    personalMessageRecoveryDeadline
  );
  while (
    (postRestartPersonalReplay.status !== 200 ||
      (postRestartPersonalReplay.body as { kind?: string } | null)?.kind !== 'idempotent_replay') &&
    Date.now() < personalMessageRecoveryDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, personalMessageRecoveryDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= personalMessageRecoveryDeadline) break;
    postRestartPersonalReplay = await requestPostRestartPersonalMessage(
      personalMessage,
      Math.max(1, Math.min(2_000, personalMessageRecoveryDeadline - Date.now())),
      personalMessageRecoveryDeadline
    );
  }
  expect(postRestartPersonalReplay).toMatchObject({
    networkError: false,
    status: 200,
  });
  expect(postRestartPersonalReplay.body).toEqual({
    ...personalMessageBody,
    kind: 'idempotent_replay',
    receipt: {
      ...personalMessageBody.receipt,
      runtimeDelivery: 'operator_required',
    },
  });
  expect(JSON.parse(String(postRestartPersonalReplay.rawBody))).toEqual(
    postRestartPersonalReplay.body
  );
  const personalMessageMismatchDeadline = Date.now() + 5_000;
  const postRestartPersonalMismatch = await requestPostRestartPersonalMessage(
    `${personalMessage} with a different payload`,
    5_000,
    personalMessageMismatchDeadline
  );
  expect(postRestartPersonalMismatch).toMatchObject({
    networkError: false,
    status: 409,
  });
  expect(postRestartPersonalMismatch.body).toEqual({
    schemaVersion: 1,
    kind: 'error',
    error: { code: 'conflict', reason: 'team_message_idempotency_conflict' },
    retryable: false,
  });
  expect(JSON.parse(String(postRestartPersonalMismatch.rawBody))).toEqual(
    postRestartPersonalMismatch.body
  );
  const postRestartPersonalPage = await page.evaluate(
    ({ token, teamId }) =>
      window.__hostedE2eProbe('/api/hosted/v1/team-messages/page', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 50,
        }),
      }),
    { token: csrfToken, teamId: runtime.teamId }
  );
  expect(postRestartPersonalPage.status).toBe(200);
  expect(
    (
      postRestartPersonalPage.body as {
        messages: Array<{ messageId: string; text: string }>;
      }
    ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
  ).toEqual([
    expect.objectContaining({
      messageId: personalMessageBody.receipt.messageId,
      text: personalMessage,
    }),
  ]);
  expect(await readFile(personalInboxPath, 'utf8')).toBe(personalInboxAfterDeliveryBytes);
  expect(await readFile(runtime.fakeRuntimeStateFile, 'utf8')).toBe(postRestartRuntimeBeforeBytes);
  const postRestartPersonalState = JSON.parse(postRestartRuntimeBeforeBytes) as {
    messageLedger: Array<{ clientMessageId: string; delivered: boolean }>;
  };
  expect(
    postRestartPersonalState.messageLedger.filter(
      ({ clientMessageId }) => clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([expect.objectContaining({ delivered: true })]);
  const postRestartInboxRows = JSON.parse(personalInboxAfterDeliveryBytes) as Array<{
    hostedOperation?: { clientMessageId?: string };
    hostedDelivery?: { acknowledgement?: string };
  }>;
  expect(
    postRestartInboxRows.filter(
      (row) => row.hostedOperation?.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      hostedDelivery: expect.objectContaining({ acknowledgement: 'durable' }),
    }),
  ]);
  await testInfo.attach('personal-message-post-restart-durability.json', {
    body: JSON.stringify(
      {
        replay: postRestartPersonalReplay,
        mismatch: postRestartPersonalMismatch,
        projectedMessageCount: (
          postRestartPersonalPage.body as { messages: Array<{ messageId: string }> }
        ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
          .length,
        inboxByteStable: true,
        runtimeStateByteStable: true,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: personalMessage })
  ).toHaveCount(1);

  const originalBootstrap = process.env.E2E_LIFECYCLE_BOOTSTRAP;
  if (!originalBootstrap) throw new Error('hosted_e2e_mount_bootstrap_missing');
  const originalMountGeneration = (
    JSON.parse(originalBootstrap) as {
      workspaceManifest: { registrations: [{ mountBinding: { mountGeneration: number } }] };
    }
  ).workspaceManifest.registrations[0].mountBinding.mountGeneration;
  const fakeRuntimeStateDir = resolve(runtime.fakeRuntimeStateFile, '..');
  const scenarioRoot = resolve(fakeRuntimeStateDir, '..');
  const markerPath = resolve(scenarioRoot, '.agent-teams-hosted-v1-e2e-owner.json');
  const ownerGenerationPath = resolve(fakeRuntimeStateDir, 'owner-generation.json');
  const ownerGenerationBeforeRestart = JSON.parse(await readFile(ownerGenerationPath, 'utf8')) as {
    generation: number;
    marker: string;
  };
  const ownerGenerationBeforeRestartBytes = await readFile(ownerGenerationPath, 'utf8');
  const fakeRuntimeContainerBeforeStaleAdmission = (
    await compose('ps', '--quiet', 'fake-runtime')
  ).trim();
  expect(fakeRuntimeContainerBeforeStaleAdmission).not.toBe('');
  await compose('stop', '--timeout', '30', 'hosted-controller');
  const admissionEnvelope = JSON.parse(
    await readFile(resolve(scenarioRoot, 'lifecycle-run', 'lifecycle-owner-admission.json'), 'utf8')
  ) as { payload?: string };
  expect(typeof admissionEnvelope.payload).toBe('string');
  const admittedPayload = JSON.parse(admissionEnvelope.payload as string) as {
    bootstrapBinding?: { bootstrapDigest?: string; mountGeneration?: number };
  };
  expect(admittedPayload.bootstrapBinding).toMatchObject({
    bootstrapDigest: createHash('sha256').update(originalBootstrap).digest('hex'),
    mountGeneration: originalMountGeneration,
  });
  const freshMount = await advanceHostedV1MountGeneration({
    bootstrap: originalBootstrap,
    fakeRuntimeStateDir,
    markerPath,
    root: scenarioRoot,
  });
  expect(freshMount.mountGeneration).toBe(originalMountGeneration + 1);
  const freshMountStatePath = resolve(fakeRuntimeStateDir, 'mount-generation.json');
  const freshMountStateBytes = await readFile(freshMountStatePath, 'utf8');
  await expect(
    advanceHostedV1MountGeneration({
      bootstrap: originalBootstrap,
      fakeRuntimeStateDir,
      markerPath,
      root: scenarioRoot,
    })
  ).rejects.toThrow('hosted_e2e_mount_generation_stale');
  expect(await readFile(freshMountStatePath, 'utf8')).toBe(freshMountStateBytes);

  await compose('up', '--detach', '--no-build', '--no-deps', '--no-recreate', 'hosted-controller');
  expect((await compose('ps', '--quiet', 'fake-runtime')).trim()).toBe(
    fakeRuntimeContainerBeforeStaleAdmission
  );
  let staleRuntimeTrace: Array<{
    expectedMountGeneration?: number;
    operation?: string;
    receivedMountGeneration?: number;
    stage?: string;
  }> = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            staleRuntimeTrace = JSON.parse(
              await readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8')
            ) as typeof staleRuntimeTrace;
          } catch {
            return false;
          }
          return staleRuntimeTrace.some(
            (entry) =>
              entry.operation === 'readiness' &&
              entry.stage === 'mount_generation_stale' &&
              entry.expectedMountGeneration === freshMount.mountGeneration &&
              entry.receivedMountGeneration === originalMountGeneration
          );
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    expect(await readFile(ownerGenerationPath, 'utf8')).toBe(ownerGenerationBeforeRestartBytes);
  } finally {
    await compose('down', '--timeout', '30', '--remove-orphans');
  }
  await testInfo.attach('personal-stale-mount-generation-rejection.json', {
    body: JSON.stringify(
      {
        originalMountGeneration,
        expectedMountGeneration: freshMount.mountGeneration,
        admissionManifestBootstrapMatched: true,
        fakeRuntimeContainerRestarted: false,
        ownerGenerationByteStable: true,
        trace: staleRuntimeTrace,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });

  process.env.E2E_LIFECYCLE_BOOTSTRAP = freshMount.bootstrap;
  await compose('up', '--detach', '--wait', '--no-build');
  let freshRuntimeTrace: Array<{
    mountGeneration?: number;
    operation?: string;
    ownerGeneration?: number;
    stage?: string;
  }> = [];
  await expect
    .poll(
      async () => {
        try {
          freshRuntimeTrace = JSON.parse(
            await readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8')
          ) as typeof freshRuntimeTrace;
        } catch {
          return false;
        }
        return freshRuntimeTrace.some(
          (entry) =>
            entry.operation === 'readiness' &&
            entry.stage === 'ready' &&
            entry.mountGeneration === freshMount.mountGeneration
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const ownerGenerationAfterRestart = JSON.parse(await readFile(ownerGenerationPath, 'utf8')) as {
    generation: number;
    marker: string;
  };
  expect(ownerGenerationAfterRestart.marker).toBe(ownerGenerationBeforeRestart.marker);
  expect(ownerGenerationAfterRestart.generation).toBeGreaterThan(
    ownerGenerationBeforeRestart.generation
  );
  expect(freshRuntimeTrace[0]).toMatchObject({
    operation: 'startup',
    stage: 'ready',
    mountGeneration: freshMount.mountGeneration,
  });
  expect(freshRuntimeTrace).toContainEqual(
    expect.objectContaining({
      operation: 'readiness',
      stage: 'ready',
      mountGeneration: freshMount.mountGeneration,
      ownerGeneration: ownerGenerationAfterRestart.generation,
    })
  );
  expect(freshRuntimeTrace).not.toContainEqual(
    expect.objectContaining({ stage: 'mount_generation_stale' })
  );
  await testInfo.attach('personal-complete-restart-mount-generation.json', {
    body: JSON.stringify(
      {
        priorMountGeneration: originalMountGeneration,
        freshMountGeneration: freshMount.mountGeneration,
        monotonicStep: freshMount.mountGeneration - originalMountGeneration,
        staleBootstrapRejectedByFixtureDriver: true,
        staleBootstrapRejectedByOwnerReadiness: true,
        durableStateByteStableAfterStaleAttempt: true,
        ownerGeneration: {
          before: ownerGenerationBeforeRestart.generation,
          after: ownerGenerationAfterRestart.generation,
        },
        runtimeStartup: freshRuntimeTrace[0],
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await (await exactRuntimeTeamButton(page)).click();
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: personalMessage })
  ).toHaveCount(1);
  expect(await readFile(personalInboxPath, 'utf8')).toBe(personalInboxAfterDeliveryBytes);
  const completeRestartRuntimeState = JSON.parse(
    await readFile(runtime.fakeRuntimeStateFile, 'utf8')
  ) as { messageLedger: Array<{ clientMessageId: string; delivered: boolean }> };
  expect(
    completeRestartRuntimeState.messageLedger.filter(
      ({ clientMessageId }) => clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([expect.objectContaining({ delivered: true })]);
  await expect(readFile(taskWalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  const originalSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  )?.value;
  const personalLogoutResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/auth/logout';
  });
  const personalLogoutReloadPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  void personalLogoutResponsePromise.catch(() => undefined);
  void personalLogoutReloadPromise.catch(() => undefined);
  await page.getByRole('button', { name: 'Sign out' }).click();
  const personalLogoutResponse = await personalLogoutResponsePromise;
  await testInfo.attach('personal-local-logout-response.json', {
    body: JSON.stringify(
      {
        method: personalLogoutResponse.request().method(),
        url: personalLogoutResponse.url(),
        status: personalLogoutResponse.status(),
        headers: await personalLogoutResponse.allHeaders(),
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(personalLogoutResponse.status()).toBe(200);
  await personalLogoutReloadPromise;
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  let renewedSession: string | undefined;
  await expect
    .poll(async () => {
      renewedSession = (await context.cookies(runtime.origin)).find(
        (cookie) => cookie.name === '__Host-agent-teams-session'
      )?.value;
      return Boolean(renewedSession && renewedSession !== originalSession);
    })
    .toBe(true);
  expect(renewedSession).toBeTruthy();

  await page.getByRole('button', { name: 'Forget browser' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  expect(
    (await context.cookies(runtime.origin)).filter((cookie) =>
      cookie.name.startsWith('__Host-agent-teams-')
    )
  ).toHaveLength(0);
});

test('production HTTPS OIDC flow uses the isolated provider without pairing fallback', async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(runtime.authMode !== 'oidc', 'OIDC-mode scenario only');
  const documentResponse = await page.goto(runtime.origin, {
    waitUntil: 'domcontentloaded',
  });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await expect(page.getByText('Continue with Synthetic OIDC.')).toBeVisible();

  const oidcNavigationUrls: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) oidcNavigationUrls.push(request.url());
  });
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  await expect(page.getByText('Synthetic OIDC Owner')).toBeVisible();
  await expect(page.getByText('owner', { exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(runtime.origin);
  const providerAuthorizationNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(({ pathname }) => pathname === '/authorize');
  expect(providerAuthorizationNavigation).toBeDefined();
  expect(providerAuthorizationNavigation?.searchParams.get('client_id')).toBe(
    'agent-teams-hosted-e2e'
  );
  expect(providerAuthorizationNavigation?.searchParams.get('redirect_uri')).toBe(
    `${runtime.origin}/api/auth/oidc/callback`
  );
  expect(providerAuthorizationNavigation?.searchParams.get('response_type')).toBe('code');
  expect(providerAuthorizationNavigation?.searchParams.get('code_challenge_method')).toBe('S256');
  const callbackNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(
      ({ origin, pathname }) => origin === runtime.origin && pathname === '/api/auth/oidc/callback'
    );
  expect(callbackNavigation).toBeDefined();
  expect([...callbackNavigation!.searchParams.keys()].sort()).toEqual(['code', 'state']);
  expect(callbackNavigation?.searchParams.get('code')).toMatch(/\S/u);
  expect(callbackNavigation?.searchParams.get('state')).toMatch(/\S/u);

  const status = await page.evaluate(async () => {
    return window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
  });
  const statusBody =
    typeof status.body === 'object' && status.body !== null && !Array.isArray(status.body)
      ? (status.body as Record<string, unknown>)
      : {};
  const statusPrincipal =
    typeof statusBody.principal === 'object' &&
    statusBody.principal !== null &&
    !Array.isArray(statusBody.principal)
      ? (statusBody.principal as Record<string, unknown>)
      : {};
  const csrfToken = typeof statusBody.csrfToken === 'string' ? statusBody.csrfToken : null;
  const authenticatedStatusEvidence = {
    status: status.status,
    mode: typeof statusBody.mode === 'string' ? statusBody.mode : null,
    authenticated: typeof statusBody.authenticated === 'boolean' ? statusBody.authenticated : null,
    principalDisplayName:
      typeof statusPrincipal.displayName === 'string' ? statusPrincipal.displayName : null,
    principalRole: typeof statusPrincipal.role === 'string' ? statusPrincipal.role : null,
    principalAuthenticationMethod:
      typeof statusPrincipal.authenticationMethod === 'string'
        ? statusPrincipal.authenticationMethod
        : null,
    csrfTokenPresent: csrfToken !== null,
    csrfTokenFormatValid: csrfToken !== null && /^[A-Za-z0-9_-]{32,}$/u.test(csrfToken),
  };
  expect(authenticatedStatusEvidence).toEqual({
    status: 200,
    mode: 'oidc',
    authenticated: true,
    principalDisplayName: 'Synthetic OIDC Owner',
    principalRole: 'owner',
    principalAuthenticationMethod: 'oidc',
    csrfTokenPresent: true,
    csrfTokenFormatValid: true,
  });
  if (!csrfToken) throw new Error('hosted_e2e_oidc_csrf_token_missing');

  const cookies = await context.cookies(runtime.origin);
  const session = cookies.find((cookie) => cookie.name === '__Host-agent-teams-session');
  const sessionCookieEvidence = {
    present: session !== undefined,
    secure: session?.secure ?? null,
    httpOnly: session?.httpOnly ?? null,
    sameSite: session?.sameSite ?? null,
    path: session?.path ?? null,
  };
  expect(sessionCookieEvidence).toEqual({
    present: true,
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  if (session === undefined) throw new Error('hosted_e2e_oidc_session_cookie_missing');
  expect(cookies.some((cookie) => cookie.name === '__Host-agent-teams-device')).toBe(false);
  expect(cookies.some((cookie) => cookie.name.startsWith('__Host-agent-teams-oidc-'))).toBe(false);

  const providerOrigin = providerAuthorizationNavigation!.origin;
  const cookieHeader = `${session.name}=${session.value}`;
  const foreignAuthorityBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 10_000,
    perAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
  });
  for (const [name, tlsOrigin, authority] of [
    ['application SNI with OIDC authority', runtime.origin, new URL(providerOrigin).host],
    ['OIDC SNI with application authority', providerOrigin, new URL(runtime.origin).host],
  ] as const) {
    const mismatchedHost = await probeForeignAuthority(
      tlsOrigin,
      cookieHeader,
      authority,
      foreignAuthorityBudget
    );
    const mismatchedHostEvidence = {
      status: mismatchedHost.headers[':status'] ?? null,
      setCookiePresent: mismatchedHost.headers['set-cookie'] !== undefined,
      authenticatedTrueMarkerPresent: /"authenticated"\s*:\s*true/u.test(mismatchedHost.body),
    };
    await testInfo.attach(`${name.replaceAll(' ', '-')}-response.json`, {
      body: JSON.stringify(mismatchedHostEvidence, null, 2),
      contentType: 'application/json',
    });
    expect(mismatchedHostEvidence, name).toEqual({
      status: 421,
      setCookiePresent: false,
      authenticatedTrueMarkerPresent: false,
    });
  }

  await selectRegisteredWorkspace(page);
  const teamButton = await exactRuntimeTeamButton(page);
  await teamButton.click();
  await page.getByLabel('New task title').fill('OIDC owner sandbox task');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'oidc-create-task', () =>
    page.getByRole('button', { name: 'Save task' }).click()
  );
  await expect(page.getByText('OIDC owner sandbox task')).toBeVisible();

  const oidcMessage = 'OIDC owner durable delivery proof';
  const messageResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-messages/send'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  void messageResponsePromise.catch(() => undefined);
  await page.getByLabel('New message').fill(oidcMessage);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const messageResponse = await messageResponsePromise;
  await testInfo.attach('oidc-owner-message-send-response.json', {
    body: JSON.stringify(messageResponse, null, 2),
    contentType: 'application/json',
  });
  expect(messageResponse.capture, 'OIDC message response capture source').toBe(
    'playwright_original_response'
  );
  expect(messageResponse.method, 'OIDC owner message send method').toBe('POST');
  expect(new URL(messageResponse.url).pathname, 'OIDC owner message send path').toBe(
    '/api/hosted/v1/team-messages/send'
  );
  expect(messageResponse.status, 'OIDC owner message send status').toBe(200);
  expect(
    messageResponse.bodyBytes,
    'OIDC bounded original message response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  const oidcMessageBody = JSON.parse(messageResponse.rawBody) as {
    kind: string;
    receipt: { messageId: string; clientMessageId: string };
  };
  expect(oidcMessageBody, 'OIDC owner fresh durable delivery receipt').toMatchObject({
    kind: 'persisted',
    receipt: {
      schemaVersion: 1,
      teamId: runtime.teamId,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
      clientMessageId: expect.stringMatching(/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
      persistence: 'durable',
      runtimeDelivery: 'delivered',
    },
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: oidcMessage })
  ).toBeVisible();
  const oidcMessageReplayAndPage = await page.evaluate(
    async ({ token, teamId, text, clientMessageId }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const replay = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/send',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({ schemaVersion: 1, teamId, clientMessageId, text }),
        },
        { overallDeadlineAtMs }
      );
      const pageResponse = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/page',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: 50,
          }),
        },
        { overallDeadlineAtMs }
      );
      return { replay, page: pageResponse };
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      text: oidcMessage,
      clientMessageId: oidcMessageBody.receipt.clientMessageId,
    }
  );
  expect(oidcMessageReplayAndPage.replay).toMatchObject({
    status: 200,
    body: {
      kind: 'idempotent_replay',
      receipt: {
        messageId: oidcMessageBody.receipt.messageId,
        clientMessageId: oidcMessageBody.receipt.clientMessageId,
      },
    },
  });
  expect(oidcMessageReplayAndPage.page).toMatchObject({
    status: 200,
    body: {
      messages: expect.arrayContaining([
        expect.objectContaining({
          messageId: oidcMessageBody.receipt.messageId,
          text: oidcMessage,
        }),
      ]),
    },
  });

  const lifecycleRead = await page.evaluate(
    async ({ token }) => {
      return window.__hostedE2eProbe('/api/teams/lifecycle/read', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({ schemaVersion: 1, cursor: null, expectedRevision: null }),
      });
    },
    { token: csrfToken }
  );
  expect(lifecycleRead.status).toBe(200);
  const lifecycleItem = (
    lifecycleRead.body as {
      items: { revision: string; teamId: string; workspaceId: string }[];
    }
  ).items.find(
    (item) => item.teamId === runtime.teamId && item.workspaceId === runtime.workspaceId
  );
  expect(lifecycleItem?.revision).toMatch(/^revision_/u);
  if (lifecycleItem === undefined) throw new Error('hosted_e2e_oidc_active_team_missing');
  const lifecycleResponse = await page.evaluate(
    async ({ token, identity }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-oidc-owner',
          idempotencyKey: 'idempotency_hosted-v1-oidc-owner',
          workspaceId: identity.workspaceId,
          teamId: identity.teamId,
          expectedRevision: identity.revision,
        }),
      });
    },
    { token: csrfToken, identity: lifecycleItem }
  );
  await testInfo.attach('oidc-owner-lifecycle-launch-response.json', {
    body: JSON.stringify(lifecycleResponse, null, 2),
    contentType: 'application/json',
  });
  expect(lifecycleResponse).toMatchObject({
    status: 202,
    body: {
      schemaVersion: 1,
      kind: 'accepted',
      action: 'launch',
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
      resourceRevision: expect.stringMatching(/^revision_/u),
      runId: expect.stringMatching(/^run_/u),
    },
  });
  expect((lifecycleResponse.body as { resourceRevision: string }).resourceRevision).not.toBe(
    lifecycleItem.revision
  );
  const lifecycleEvidence = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: { teamId: string; runId: string }[];
    commands: { action: string; teamId: string; runId: string }[];
    eventIds: string[];
  };
  const oidcRunId = String((lifecycleResponse.body as { runId: string }).runId);
  expect(lifecycleEvidence.commands).toContainEqual(
    expect.objectContaining({
      action: 'launch',
      teamId: runtime.teamId,
      runId: oidcRunId,
    })
  );
  expect(lifecycleEvidence.activeRuns).toContainEqual({ teamId: runtime.teamId, runId: oidcRunId });
  expect(lifecycleEvidence.eventIds).toHaveLength(1);

  const oidcStop = await page.evaluate(
    async ({ token, workspaceId, teamId, runId, expectedRevision }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/stop', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-oidc-owner-stop',
          idempotencyKey: 'idempotency_hosted-v1-oidc-owner-stop',
          workspaceId,
          teamId,
          runId,
          expectedRevision,
        }),
      });
    },
    {
      token: csrfToken,
      workspaceId: runtime.workspaceId,
      teamId: runtime.teamId,
      runId: oidcRunId,
      expectedRevision: String(
        (lifecycleResponse.body as { resourceRevision: string }).resourceRevision
      ),
    }
  );
  expect(oidcStop).toMatchObject({
    status: 202,
    body: { kind: 'accepted', action: 'stop', runId: oidcRunId },
  });
  const stoppedOidcLifecycle = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: unknown[];
    commands: { action: string }[];
  };
  expect(stoppedOidcLifecycle.activeRuns).toEqual([]);
  expect(stoppedOidcLifecycle.commands.at(-1)).toMatchObject({ action: 'stop' });

  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  const providerLogoutNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(({ pathname }) => pathname === '/logout');
  expect(providerLogoutNavigation).toBeDefined();
  expect(providerLogoutNavigation?.origin).toBe(providerAuthorizationNavigation?.origin);
  expect(providerLogoutNavigation?.searchParams.get('client_id')).toBe('agent-teams-hosted-e2e');
  expect(providerLogoutNavigation?.searchParams.get('post_logout_redirect_uri')).toBe(
    `${runtime.origin}/`
  );
  expect(
    oidcNavigationUrls
      .map((value) => new URL(value))
      .some((url) => url.href === `${runtime.origin}/`)
  ).toBe(true);
  expect(
    (await context.cookies(runtime.origin)).some(
      (cookie) => cookie.name === '__Host-agent-teams-session'
    )
  ).toBe(false);
  await expectOriginalOidcSessionRevoked(
    testInfo,
    'oidc-owner-pre-logout-session-revocation',
    cookieHeader
  );
});

test('OIDC viewer is isolated from workspace mutations', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(runtime.authMode !== 'oidc-viewer', 'OIDC viewer scenario only');
  const viewerNavigationUrls: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) viewerNavigationUrls.push(request.url());
  });
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByText('viewer', { exact: true })).toBeVisible();
  const csrfToken = await page.evaluate(async () => {
    const response = await window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    return (response.body as { csrfToken: string | null }).csrfToken;
  });
  expect(
    typeof csrfToken === 'string' && /^[A-Za-z0-9_-]{32,}$/u.test(csrfToken),
    'OIDC viewer CSRF token is present and valid'
  ).toBe(true);
  if (!csrfToken) throw new Error('hosted_e2e_oidc_viewer_csrf_token_missing');
  const viewerTaskDirectory = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'tasks',
    runtime.teamName
  );
  const viewerTeamDirectory = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'teams',
    runtime.teamName
  );
  const viewerRuntimeStateBeforeText = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const viewerRuntimeStateBefore = JSON.parse(viewerRuntimeStateBeforeText) as {
    commands?: unknown[];
    taskLedger?: unknown[];
  };
  const viewerTaskFilesBefore = await snapshotDirectoryFiles(viewerTaskDirectory);
  const viewerTeamFilesBefore = await snapshotDirectoryFiles(viewerTeamDirectory);
  const viewerTaskBoardPage = await page.evaluate(
    async ({ token, teamId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  await testInfo.attach('oidc-viewer-task-board-page-response.json', {
    body: JSON.stringify(viewerTaskBoardPage, null, 2),
    contentType: 'application/json',
  });
  expect(viewerTaskBoardPage).toMatchObject({
    status: 200,
    body: {
      sourceGeneration: expect.any(String),
      revision: expect.any(String),
    },
  });
  const viewerTaskBoard = viewerTaskBoardPage.body as {
    sourceGeneration: string;
    revision: string;
  };
  await selectRegisteredWorkspace(page);
  await (await exactRuntimeTeamButton(page)).click();
  await expect(page.getByText('Marker-owned browser E2E task', { exact: true })).toBeVisible();
  await expect(page.getByText('No messages yet.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('New task title')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save task', exact: true })).toHaveCount(0);
  const messageDenial = await page.evaluate(
    async ({ token, teamId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-messages/send', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          clientMessageId: 'client_message_hosted-v1-viewer-denied',
          text: 'Viewer must not persist or deliver this message',
        }),
      });
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  await testInfo.attach('oidc-viewer-message-send-denial-response.json', {
    body: JSON.stringify(messageDenial, null, 2),
    contentType: 'application/json',
  });
  expect(messageDenial.status).toBe(403);
  expect(messageDenial.body).toEqual({ error: 'permission_denied' });
  const denial = await page.evaluate(
    async ({ token, teamId, workspaceId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-viewer',
          idempotencyKey: 'idempotency_hosted-v1-viewer',
          workspaceId,
          teamId,
          expectedRevision: 'revision_hosted-v1-e2e-0001',
        }),
      });
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
    }
  );
  await testInfo.attach('oidc-viewer-lifecycle-launch-denial-response.json', {
    body: JSON.stringify(denial, null, 2),
    contentType: 'application/json',
  });
  expect(denial.status).toBe(403);
  expect(denial.body).toEqual({ error: 'permission_denied' });
  const taskDenial = await page.evaluate(
    async ({ token, teamId, sourceGeneration, revision }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/mutations', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'create_task',
          commandId: 'command_hosted-v1-viewer-task',
          idempotencyKey: 'idempotency_hosted-v1-viewer-task',
          teamId,
          expectedSourceGeneration: sourceGeneration,
          expectedRevision: revision,
          subject: 'Viewer must not create this task',
          description: null,
          status: 'pending',
          ownerId: null,
          column: 'todo',
          order: 0,
        }),
      });
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      sourceGeneration: viewerTaskBoard.sourceGeneration,
      revision: viewerTaskBoard.revision,
    }
  );
  await testInfo.attach('oidc-viewer-task-mutation-denial-response.json', {
    body: JSON.stringify(taskDenial, null, 2),
    contentType: 'application/json',
  });
  expect(taskDenial.status).toBe(403);
  expect(taskDenial.body).toEqual({ error: 'permission_denied' });
  const viewerRuntimeStateAfterText = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const viewerRuntimeStateAfter = JSON.parse(viewerRuntimeStateAfterText) as {
    commands?: unknown[];
    taskLedger?: unknown[];
  };
  expect(viewerRuntimeStateAfterText, 'viewer denials must not rewrite runtime state').toBe(
    viewerRuntimeStateBeforeText
  );
  expect(
    viewerRuntimeStateAfter.commands,
    'viewer denial must not append lifecycle commands'
  ).toEqual(viewerRuntimeStateBefore.commands);
  expect(viewerRuntimeStateAfter.taskLedger, 'viewer denial must not append task commands').toEqual(
    viewerRuntimeStateBefore.taskLedger
  );
  expect(
    await snapshotDirectoryFiles(viewerTaskDirectory),
    'viewer task denial must not create or rewrite task files'
  ).toEqual(viewerTaskFilesBefore);
  expect(
    await snapshotDirectoryFiles(viewerTeamDirectory),
    'viewer denials must not create or rewrite team state including kanban'
  ).toEqual(viewerTeamFilesBefore);
  const viewerFakeRuntimeDirectory = resolve(runtime.fakeRuntimeStateFile, '..');
  await expect(
    readFile(resolve(viewerFakeRuntimeDirectory, 'task-mutation.wal.json'))
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(resolve(viewerFakeRuntimeDirectory, 'task-mutation.crash.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });

  const viewerSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  );
  expect(viewerSession).toBeDefined();
  if (viewerSession === undefined) throw new Error('hosted_e2e_oidc_viewer_session_cookie_missing');
  const viewerSessionCookieHeader = `${viewerSession.name}=${viewerSession.value}`;
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  expect(
    viewerNavigationUrls
      .map((value) => new URL(value))
      .some(({ pathname }) => pathname === '/logout')
  ).toBe(true);
  expect(
    (await context.cookies(runtime.origin)).some(
      (cookie) =>
        cookie.name === '__Host-agent-teams-session' ||
        cookie.name.startsWith('__Host-agent-teams-oidc')
    )
  ).toBe(false);
  await expectOriginalOidcSessionRevoked(
    testInfo,
    'oidc-viewer-pre-logout-session-revocation',
    viewerSessionCookieHeader
  );
});
