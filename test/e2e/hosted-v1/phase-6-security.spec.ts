import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, type Page, test } from '@playwright/test';

interface RuntimeInput {
  readonly authMode: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly fakeRuntimeLifecycleTraceFile: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly teamId: string;
  readonly workspaceDir: string;
  readonly workspaceId: string;
}

interface LifecycleControlState {
  readonly availableActions: readonly string[];
  readonly resourceRevision: string;
  readonly runId: string | null;
}

const runtimePath = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimePath) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeInput;
const execFileAsync = promisify(execFile);

async function compose(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    'docker',
    ['compose', '--project-name', runtime.composeProject, '--file', runtime.composeFile, ...args],
    { maxBuffer: 8 * 1024 * 1024, timeout: 90_000 }
  );
  return `${result.stdout}${result.stderr}`;
}

async function pairingCode(): Promise<string> {
  return (
    await compose(
      'exec',
      '-T',
      'hosted-controller',
      'node',
      'scripts/hosted-auth-cli.mjs',
      'pairing-code'
    )
  ).trim();
}

async function pair(page: Page, code: string): Promise<void> {
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
}

async function authStatus(page: Page): Promise<{ authenticated: boolean; mode: string }> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    return (await response.json()) as { authenticated: boolean; mode: string };
  });
}

async function authCsrf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    const body = (await response.json()) as { csrfToken: string | null };
    if (response.status !== 200 || body.csrfToken === null) {
      throw new Error('hosted_e2e_phase6_authenticated_csrf_missing');
    }
    return body.csrfToken;
  });
}

async function lifecycleControlState(
  page: Page,
  csrfToken: string
): Promise<LifecycleControlState> {
  return page.evaluate(
    async ({ csrfToken, teamId, workspaceId }) => {
      const response = await fetch('/api/hosted/v1/team-lifecycle/control-state', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
        body: JSON.stringify({ schemaVersion: 1, teamId, workspaceId }),
      });
      const body = (await response.json()) as LifecycleControlState & { kind?: string };
      if (response.status !== 200 || body.kind !== 'control_state') {
        throw new Error(`hosted_e2e_phase6_control_state_unavailable:${response.status}`);
      }
      return body;
    },
    { csrfToken, teamId: runtime.teamId, workspaceId: runtime.workspaceId }
  );
}

test('Phase 6 uses browser storage and real network responses for rotation, replay revocation, and host reset', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(4 * 60_000);
  if (runtime.authMode !== 'personal' || runtime.pairingCode === null) {
    throw new Error('hosted_e2e_phase6_requires_personal_mode');
  }
  await pair(page, runtime.pairingCode);

  const predecessorStorage = await context.storageState();
  const activeCookiesAtDropBoundary = await context.cookies(runtime.origin);
  const droppedResponseContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: predecessorStorage,
  });
  await droppedResponseContext.clearCookies({ name: '__Host-agent-teams-session' });
  const rotatedResponse = await droppedResponseContext.request.get(
    `${runtime.origin}/api/auth/status`
  );
  expect(rotatedResponse.status()).toBe(200);
  expect(rotatedResponse.headers()['set-cookie']).toContain('__Host-agent-teams-device=');
  expect(await droppedResponseContext.cookies(runtime.origin)).not.toEqual(
    activeCookiesAtDropBoundary
  );
  // The rotating request ran in an isolated transport cookie jar. Discarding that jar models a
  // response lost after the server committed while proving Chromium's active jar never received it.
  await droppedResponseContext.close();
  expect(await context.cookies(runtime.origin)).toEqual(activeCookiesAtDropBoundary);

  await context.clearCookies({ name: '__Host-agent-teams-session' });
  expect(await authStatus(page)).toEqual({ authenticated: true, mode: 'personal' });
  const recoveredDevice = (await context.cookies(runtime.origin)).find(
    ({ name }) => name === '__Host-agent-teams-device'
  );
  const predecessorDevice = activeCookiesAtDropBoundary.find(
    ({ name }) => name === '__Host-agent-teams-device'
  );
  expect(recoveredDevice?.value).toBeTruthy();
  expect(recoveredDevice?.value).not.toBe(predecessorDevice?.value);

  const replayContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: predecessorStorage,
  });
  await replayContext.clearCookies({ name: '__Host-agent-teams-session' });
  const replayPage = await replayContext.newPage();
  await replayPage.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  expect(await authStatus(replayPage)).toEqual({ authenticated: false, mode: 'personal' });
  await expect.poll(() => authStatus(page)).toEqual({ authenticated: false, mode: 'personal' });

  const resetOne = JSON.parse(
    await compose(
      'exec',
      '-T',
      'hosted-controller',
      'node',
      'scripts/hosted-auth-cli.mjs',
      'personal-reset',
      '1'
    )
  ) as { resetGeneration: number };
  expect(resetOne).toEqual({ resetGeneration: 1 });
  const resetOneCode = await pairingCode();
  expect(resetOneCode).not.toBe(runtime.pairingCode);
  await pair(page, resetOneCode);

  const streamResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/hosted/v1/events') && response.request().method() === 'GET'
  );
  const streamDrained = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const source = new EventSource('/api/hosted/v1/events');
        const timeout = window.setTimeout(() => {
          source.close();
          resolve(false);
        }, 20_000);
        source.onerror = () => {
          window.clearTimeout(timeout);
          source.close();
          resolve(true);
        };
      })
  );
  expect((await streamResponse).status()).toBe(200);
  const oldResetStorage = await context.storageState();
  expect(
    JSON.parse(
      await compose(
        'exec',
        '-T',
        'hosted-controller',
        'node',
        'scripts/hosted-auth-cli.mjs',
        'personal-reset',
        '2'
      )
    )
  ).toEqual({ resetGeneration: 2 });
  await expect(streamDrained).resolves.toBe(true);

  const oldResetContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: oldResetStorage,
  });
  const oldResetPage = await oldResetContext.newPage();
  await oldResetPage.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  expect(await authStatus(oldResetPage)).toEqual({ authenticated: false, mode: 'personal' });
  const resetTwoCode = await pairingCode();
  expect(resetTwoCode).not.toBe(resetOneCode);
  await pair(page, resetTwoCode);

  await Promise.all([replayContext.close(), oldResetContext.close()]);
  expect(
    JSON.parse(
      await compose(
        'exec',
        '-T',
        'hosted-controller',
        'node',
        'scripts/hosted-auth-cli.mjs',
        'personal-reset',
        '3'
      )
    )
  ).toEqual({ resetGeneration: 3 });
});

test('Hosted lifecycle fixture keeps its admitted fake-runtime effect on the pinned bind mount during host rebinding', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  if (runtime.authMode !== 'personal') throw new Error('hosted_e2e_phase6_requires_personal_mode');
  await pair(page, await pairingCode());
  const csrfToken = await authCsrf(page);
  const control = await lifecycleControlState(page, csrfToken);
  expect(control.availableActions).toContain('launch');

  const sandboxRoot = dirname(runtime.workspaceDir);
  const outsideDirectory = join(sandboxRoot, 'outside-workspace-rebinding');
  const outsideMarker = join(outsideDirectory, 'outside-marker.txt');
  const parkedWorkspace = `${runtime.workspaceDir}-registered`;
  await mkdir(outsideDirectory, { recursive: true, mode: 0o700 });
  await writeFile(outsideMarker, 'outside-intact\n', { mode: 0o600 });
  const traceBefore = await readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8');

  let workspaceParked = false;
  try {
    await rename(runtime.workspaceDir, parkedWorkspace);
    workspaceParked = true;
    await symlink(outsideDirectory, runtime.workspaceDir);
    const launchResponse = await page.evaluate(
      async ({ csrfToken, expectedRevision, teamId, workspaceId }) => {
        const nonce = crypto.randomUUID().replaceAll('-', '');
        const response = await fetch('/api/hosted/v1/team-lifecycle/launch', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
          body: JSON.stringify({
            schemaVersion: 1,
            commandId: `lifecycle-command_phase6-rebinding-${nonce}`,
            idempotencyKey: `idempotency_phase6-rebinding-${nonce}`,
            teamId,
            workspaceId,
            expectedRevision,
          }),
        });
        return { status: response.status, body: (await response.json()) as { kind?: string } };
      },
      {
        csrfToken,
        expectedRevision: control.resourceRevision,
        teamId: runtime.teamId,
        workspaceId: runtime.workspaceId,
      }
    );
    expect(launchResponse).toMatchObject({ status: 202, body: { kind: 'accepted' } });
    await expect
      .poll(() => readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8'))
      .not.toBe(traceBefore);
    expect(await readdir(outsideDirectory)).toEqual(['outside-marker.txt']);
    expect(await readFile(outsideMarker, 'utf8')).toBe('outside-intact\n');
  } finally {
    await rm(runtime.workspaceDir, { force: true });
    if (workspaceParked) await rename(parkedWorkspace, runtime.workspaceDir);
  }
});
