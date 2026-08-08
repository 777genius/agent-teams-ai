import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

interface RuntimeInput {
  readonly authMode: 'oidc' | 'oidc-viewer' | 'personal';
  readonly composeFile: string;
  readonly composeProject: string;
  readonly eventCursor: string;
  readonly fakeRuntimeStateFile: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly runtimeWorkspaceId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly workspaceId: string;
}

const runtimePath = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimePath) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeInput;
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
  });
  return `${result.stdout}${result.stderr}`;
}

test('production HTTPS personal flow remains sandboxed and truthful', async ({ context, page }) => {
  test.skip(runtime.authMode !== 'personal', 'personal-mode scenario only');
  if (runtime.pairingCode === null) throw new Error('hosted_e2e_pairing_code_missing');
  const documentResponse = await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(documentResponse?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();

  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  const teamButton = page.getByRole('button').filter({ hasText: runtime.teamName }).first();
  await expect(teamButton).toBeVisible();

  const cookies = await context.cookies(runtime.origin);
  for (const name of ['__Host-agent-teams-session', '__Host-agent-teams-device']) {
    const cookie = cookies.find((candidate) => candidate.name === name);
    expect(cookie, `${name} cookie`).toBeDefined();
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
  }
  expect(page.url()).not.toContain(runtime.pairingCode);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    runtime.pairingCode
  );

  const projects = await page.evaluate(async () => {
    const response = await fetch('/api/projects', { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.text() };
  });
  expect(projects.status).toBe(200);
  expect(projects.body).not.toContain('/workspaces/sandbox');
  expect(projects.body).not.toContain(runtime.runtimeWorkspaceId);
  const projectValues = JSON.parse(projects.body) as { id: string; name: string }[];
  expect(projectValues).toHaveLength(1);
  expect(projectValues[0].id).toMatch(/^workspace_[0-9a-f]{32}$/);
  expect(projectValues[0].name).toBe('sandbox');

  const csrfToken = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    const body = (await response.json()) as { csrfToken: string | null };
    return body.csrfToken;
  });
  expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  if (csrfToken === null) throw new Error('hosted_e2e_csrf_token_missing');
  const badOrigin = await context.request.post(`${runtime.origin}/api/auth/logout`, {
    data: { global: false },
    headers: {
      origin: 'https://attacker.invalid',
      'sec-fetch-site': 'cross-site',
      'x-agent-teams-csrf': csrfToken,
    },
  });
  expect(badOrigin.status()).toBe(403);
  const spoofedForwarding = await context.request.get(`${runtime.origin}/api/auth/status`, {
    headers: {
      forwarded: 'for=203.0.113.7;host=attacker.invalid;proto=http',
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'http',
    },
  });
  expect(spoofedForwarding.status()).toBe(200);
  expect(await spoofedForwarding.json()).toMatchObject({ authenticated: true });
  const foreignAuthority = await context.request.get(`${runtime.origin}/api/auth/status`, {
    headers: { host: 'attacker.invalid' },
  });
  expect(foreignAuthority.status()).not.toBe(200);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(teamButton).toBeVisible();
  await teamButton.click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('Marker-owned browser E2E task')).toBeVisible();
  await expect(page.getByText('Sandbox task-board projection fixture')).toBeVisible();

  const crossWorkspaceDraft = await page.evaluate(
    async ({ token }) => {
      const response = await fetch('/api/hosted/v1/team-configuration/draft/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          workspaceId: `workspace_${'d'.repeat(32)}`,
          idempotencyKey: 'idempotency_hosted-v1-e2e-cross-workspace',
          name: 'forbidden-cross-workspace-team',
          members: [{ name: 'lead' }],
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { token: csrfToken }
  );
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
      const response = await fetch('/api/hosted/v1/team-configuration/draft/create', {
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
      return { status: response.status, body: await response.json() };
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
    async ({ identity }) => {
      const [teamsResponse, savedResponse, lifecycleResponse] = await Promise.all([
        fetch('/api/teams', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/hosted/v1/team-configuration/saved-request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, ...identity }),
        }),
        fetch('/api/teams/lifecycle/read', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, cursor: null, expectedRevision: null }),
        }),
      ]);
      return {
        teams: { status: teamsResponse.status, body: await teamsResponse.json() },
        saved: { status: savedResponse.status, body: await savedResponse.json() },
        lifecycle: { status: lifecycleResponse.status, body: await lifecycleResponse.json() },
      };
    },
    { identity: createdIdentity }
  );
  expect(readModels.teams.status).toBe(200);
  expect(JSON.stringify(readModels.teams.body)).toContain('browser-created-team');
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
  expect(readModels.lifecycle.body).toMatchObject({ schemaVersion: 1, kind: 'success' });
  expect(
    (readModels.lifecycle.body as { items: { teamId: string; workspaceId: string }[] }).items
  ).toContainEqual(expect.objectContaining(createdIdentity));

  await page.reload({ waitUntil: 'domcontentloaded' });
  const createdTeamButton = page
    .getByRole('button')
    .filter({ hasText: 'browser-created-team' })
    .first();
  await expect(createdTeamButton).toBeVisible();
  await createdTeamButton.click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('No messages yet.')).toBeVisible();
  await page.getByLabel('New task title').fill('Browser-created sandbox task');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText('Browser-created sandbox task')).toBeVisible();
  await page
    .getByLabel('New message')
    .fill('sandbox capability prompt/message probe for the created team');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page
      .getByTestId('hosted-team-message')
      .filter({ hasText: 'sandbox capability prompt/message probe for the created team' })
  ).toBeVisible();

  const eventRequestHeaders: Promise<Record<string, string>>[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/hosted/v1/events' && url.searchParams.get('e2e') === 'resume') {
      eventRequestHeaders.push(request.allHeaders());
    }
  });
  await page.evaluate((cursor) => {
    const state = {
      source: new EventSource(
        `/api/hosted/v1/events?after=${encodeURIComponent(cursor)}&e2e=resume`
      ),
      opens: 0,
      ids: [] as string[],
    };
    state.source.onopen = () => {
      state.opens += 1;
    };
    state.source.addEventListener('coordination_event', (event) => {
      state.ids.push((event as MessageEvent).lastEventId);
    });
    (window as typeof window & { __hostedE2eSse?: typeof state }).__hostedE2eSse = state;
  }, runtime.eventCursor);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & { __hostedE2eSse?: { opens: number; ids: string[] } }
        ).__hostedE2eSse;
        return state ? { opens: state.opens, events: state.ids.length } : null;
      })
    )
    .toEqual({ opens: 1, events: 0 });

  const lifecycleLaunch = await page.evaluate(
    async (input) => {
      const response = await fetch('/api/hosted/v1/team-lifecycle/launch', {
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
      return { status: response.status, body: await response.json() };
    },
    { csrfToken, identity: createdIdentity, revision: createdRevision }
  );
  expect(lifecycleLaunch.status).toBe(202);
  expect(lifecycleLaunch.body).toMatchObject({
    schemaVersion: 1,
    kind: 'accepted',
    action: 'launch',
    teamId: createdIdentity.teamId,
    workspaceId: createdIdentity.workspaceId,
    resourceRevision: createdRevision,
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & {
            __hostedE2eSse?: { opens: number; ids: string[] };
          }
        ).__hostedE2eSse;
        return Boolean(state && state.opens === 1 && state.ids.length === 1);
      })
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

  const lifecycle = async (action: 'recover' | 'stop', sequence: number) =>
    page.evaluate(
      async (input) => {
        const response = await fetch(`/api/hosted/v1/team-lifecycle/${input.action}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': input.csrfToken,
          },
          body: JSON.stringify({
            schemaVersion: 1,
            commandId: `lifecycle-command_hosted-v1-e2e-${input.action}-${input.sequence}`,
            idempotencyKey: `idempotency_hosted-v1-e2e-${input.action}-${input.sequence}`,
            workspaceId: input.identity.workspaceId,
            teamId: input.identity.teamId,
            runId: input.runId,
            expectedRevision: input.revision,
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        action,
        csrfToken,
        identity: createdIdentity,
        revision: createdRevision,
        runId: String((lifecycleLaunch.body as { runId: string }).runId),
        sequence,
      }
    );
  const firstStop = await lifecycle('stop', 1);
  expect(firstStop).toMatchObject({
    status: 202,
    body: { action: 'stop', teamId: createdIdentity.teamId },
  });
  const recovery = await lifecycle('recover', 2);
  expect(recovery).toMatchObject({
    status: 202,
    body: { action: 'recover', teamId: createdIdentity.teamId },
  });
  const finalStop = await lifecycle('stop', 3);
  expect(finalStop).toMatchObject({
    status: 202,
    body: { action: 'stop', teamId: createdIdentity.teamId },
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
  expect(runtimeState.commands.every((command) => command.teamId === createdIdentity.teamId)).toBe(
    true
  );
  expect(
    runtimeState.commands.every(
      (command) => command.runId === (lifecycleLaunch.body as { runId: string }).runId
    )
  ).toBe(true);
  expect(runtimeState.eventIds).toHaveLength(1);
  expect(runtimeState.activeRuns).toEqual([]);

  const expectInstanceLockRejection = async () => {
    await expect(compose('run', '--no-deps', '--rm', 'hosted-controller')).rejects.toMatchObject({
      stderr: expect.stringContaining('instance_lock:'),
    });
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
  expect(shutdownLogs.match(/Shutting down\.\.\./gu)).toHaveLength(1);
  expect(shutdownLogs.match(/Shutdown complete/gu)).toHaveLength(1);
  expect(shutdownLogs.indexOf('Shutting down...')).toBeLessThan(
    shutdownLogs.indexOf('Shutdown complete')
  );
  expect((await docker('inspect', '--format', '{{ .State.ExitCode }}', controllerId)).trim()).toBe(
    '0'
  );
  await compose('up', '--detach', '--wait', '--no-build', 'hosted-controller');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & {
            __hostedE2eSse?: { opens: number; ids: string[] };
          }
        ).__hostedE2eSse;
        return state?.opens ?? 0;
      })
    )
    .toBeGreaterThanOrEqual(2);
  const resumeHeaders = await Promise.all(eventRequestHeaders);
  expect(resumeHeaders.length).toBeGreaterThanOrEqual(2);
  expect(resumeHeaders[0]['last-event-id']).toBeUndefined();
  expect(
    resumeHeaders.slice(1).some((headers) => headers['last-event-id'] === firstDeliveredCursor)
  ).toBe(true);
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
        __hostedE2eSse?: { source: EventSource };
      }
    ).__hostedE2eSse;
    state?.source.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await createdTeamButton.click();
  await expect(page.getByText('Browser-created sandbox task')).toBeVisible();

  const originalSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  )?.value;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const renewedSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  )?.value;
  expect(renewedSession).toBeTruthy();
  expect(renewedSession).not.toBe(originalSession);

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
}) => {
  test.skip(runtime.authMode !== 'oidc', 'OIDC-mode scenario only');
  const documentResponse = await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await expect(page.getByText('Continue with Synthetic OIDC.')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  await expect(page.getByText('Synthetic OIDC Owner')).toBeVisible();
  await expect(page.getByText('owner', { exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(runtime.origin);

  const status = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    return { status: response.status, body: await response.json() };
  });
  expect(status).toMatchObject({
    status: 200,
    body: {
      authenticated: true,
      mode: 'oidc',
      principal: {
        displayName: 'Synthetic OIDC Owner',
        role: 'owner',
        authenticationMethod: 'oidc',
      },
    },
  });

  const cookies = await context.cookies(runtime.origin);
  const session = cookies.find((cookie) => cookie.name === '__Host-agent-teams-session');
  expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(cookies.some((cookie) => cookie.name === '__Host-agent-teams-device')).toBe(false);
  expect(cookies.some((cookie) => cookie.name.startsWith('__Host-agent-teams-oidc-'))).toBe(false);

  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  expect(
    (await context.cookies(runtime.origin)).some(
      (cookie) => cookie.name === '__Host-agent-teams-session'
    )
  ).toBe(false);
});

test('OIDC viewer is isolated from workspace mutations', async ({ page }) => {
  test.skip(runtime.authMode !== 'oidc-viewer', 'OIDC viewer scenario only');
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByText('viewer', { exact: true })).toBeVisible();
  const csrfToken = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    return ((await response.json()) as { csrfToken: string | null }).csrfToken;
  });
  expect(csrfToken).toBeTruthy();
  const denial = await page.evaluate(
    async ({ token, teamId, workspaceId }) => {
      const response = await fetch('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token ?? '' },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-viewer',
          idempotencyKey: 'idempotency_hosted-v1-viewer',
          workspaceId,
          teamId,
          expectedRevision: 'revision_hosted-v1-e2e-0001',
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { token: csrfToken, teamId: runtime.teamId, workspaceId: runtime.workspaceId }
  );
  expect(denial).toEqual({ status: 403, body: { error: 'permission_denied' } });
});
