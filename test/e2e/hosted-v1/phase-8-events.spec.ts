import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { restartHostedV1LifecycleOwner } from '../../../scripts/e2e/hosted-v1/run';
import {
  waitForProductionCoordinationRetention,
  writeProviderInbox,
  writeProviderTask,
} from '../../fixtures/hosted-v1/adversarialState';

interface RuntimeInput {
  readonly appDataDir: string;
  readonly authMode: string;
  readonly claudeDir: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly eventCursor: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly teamId: string;
  readonly teamName: string;
  readonly workspaceId: string;
}

interface LifecycleControlState {
  readonly availableActions: readonly string[];
  readonly resourceRevision: string;
  readonly runId: string | null;
}

interface LifecycleCommandReceipt {
  readonly kind: 'accepted';
  readonly resourceRevision: string;
  readonly runId: string;
}

interface LifecycleProvisioningStatus extends LifecycleControlState {
  readonly kind: 'provisioning_status';
  readonly recentCommands: readonly {
    readonly action: string;
    readonly commandId: string;
    readonly result: { readonly kind: string };
  }[];
}

const runtimePath = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimePath) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeInput;
const execFileAsync = promisify(execFile);

async function pairAndOpenTeam(page: Page): Promise<void> {
  if (runtime.authMode !== 'personal' || runtime.pairingCode === null) {
    throw new Error('hosted_e2e_phase8_requires_personal_mode');
  }
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  const account = page.getByRole('complementary', { name: 'Hosted account' });
  const pairingCode = page.getByLabel('Pairing code');
  const initialState = await Promise.any([
    account.waitFor({ state: 'visible' }).then(() => 'authenticated' as const),
    pairingCode.waitFor({ state: 'visible' }).then(() => 'pairing' as const),
  ]);
  if (initialState === 'pairing' && !(await account.isVisible())) {
    await pairingCode.fill(runtime.pairingCode);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
  }
  await expect(account).toBeVisible();
  await page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
  const row = page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${runtime.teamId}"]`
  );
  await row.getByRole('button').click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
}

let authenticatedStorage: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser }) => {
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await pairAndOpenTeam(page);
    authenticatedStorage = await context.storageState();
  } finally {
    if (context !== null) await Promise.allSettled([context.close()]);
  }
});

async function openAuthenticatedTeam(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: authenticatedStorage,
  });
  try {
    const page = await context.newPage();
    await pairAndOpenTeam(page);
    return { context, page };
  } catch (error) {
    await Promise.allSettled([context.close()]);
    throw error;
  }
}

async function openAuthenticatedEventObserver(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: authenticatedStorage,
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${runtime.origin}/api/auth/status`, {
      waitUntil: 'domcontentloaded',
    });
    let status: unknown = null;
    try {
      status = await response?.json();
    } catch {
      status = null;
    }
    if (
      response?.status() !== 200 ||
      typeof status !== 'object' ||
      status === null ||
      Array.isArray(status) ||
      Reflect.get(status, 'authenticated') !== true
    ) {
      throw new Error('hosted_e2e_phase8_event_observer_not_authenticated');
    }
    return { context, page };
  } catch (error) {
    await Promise.allSettled([context.close()]);
    throw error;
  }
}

async function restartController(): Promise<void> {
  await restartHostedV1LifecycleOwner({
    compose: async (...args) =>
      (
        await execFileAsync(
          'docker',
          [
            'compose',
            '--project-name',
            runtime.composeProject,
            '--file',
            runtime.composeFile,
            ...args,
          ],
          { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }
        )
      ).stdout,
  });
}

async function setCaddyPaused(paused: boolean): Promise<void> {
  await execFileAsync(
    'docker',
    [
      'compose',
      '--project-name',
      runtime.composeProject,
      '--file',
      runtime.composeFile,
      paused ? 'pause' : 'unpause',
      'caddy',
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }
  );
}

async function nextSseEvent(
  page: Page,
  cursor: string,
  expectedTopLevelEventType?: string
): Promise<{ eventType: string; data: Record<string, unknown>; id: string }> {
  return page.evaluate(
    ({ after, expectedTopLevelEventType }) =>
      new Promise((resolve, reject) => {
        const source = new EventSource(`/api/hosted/v1/events?after=${encodeURIComponent(after)}`);
        const timeout = window.setTimeout(() => {
          source.close();
          reject(new Error('hosted_e2e_sse_observation_timeout'));
        }, 25_000);
        const finish = (eventType: string, event: MessageEvent) => {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          if (
            expectedTopLevelEventType !== undefined &&
            data.eventType !== expectedTopLevelEventType
          ) {
            return;
          }
          window.clearTimeout(timeout);
          source.close();
          resolve({ eventType, data, id: event.lastEventId });
        };
        source.addEventListener('coordination_event', (event) =>
          finish('coordination_event', event as MessageEvent)
        );
        source.addEventListener('resync_required', (event) =>
          finish('resync_required', event as MessageEvent)
        );
        source.onerror = () => {
          window.clearTimeout(timeout);
          source.close();
          reject(new Error('hosted_e2e_sse_observation_failed'));
        };
      }),
    { after: cursor, expectedTopLevelEventType }
  );
}

async function beginSseObservation(
  page: Page,
  cursor: string,
  expectedTopLevelEventType?: string
): Promise<Readonly<{ event: ReturnType<typeof nextSseEvent> }>> {
  const expectedPath = `/api/hosted/v1/events?after=${encodeURIComponent(cursor)}`;
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'GET' &&
      new URL(candidate.url()).pathname + new URL(candidate.url()).search === expectedPath
  );
  const event = nextSseEvent(page, cursor, expectedTopLevelEventType);
  void event.catch(() => undefined);
  if ((await response).status() !== 200) {
    throw new Error('hosted_e2e_sse_observation_unavailable');
  }
  return Object.freeze({ event });
}

async function authCsrf(page: Page): Promise<string> {
  let csrfToken: string | null = null;
  await expect
    .poll(
      async () => {
        const observation = await page
          .evaluate(async () => {
            const response = await fetch('/api/auth/status', {
              credentials: 'include',
              cache: 'no-store',
            });
            const status = (await response.json()) as { csrfToken: string | null };
            return { responseStatus: response.status, csrfToken: status.csrfToken };
          })
          .catch(() => null);
        csrfToken = observation?.csrfToken ?? null;
        return (
          observation?.responseStatus === 200 &&
          typeof csrfToken === 'string' &&
          /^[A-Za-z0-9_-]{32,}$/u.test(csrfToken)
        );
      },
      {
        message: 'hosted_e2e_phase8_authenticated_csrf_missing',
        timeout: 30_000,
        intervals: [100, 250, 500, 1_000],
      }
    )
    .toBe(true);
  if (csrfToken === null) throw new Error('hosted_e2e_phase8_authenticated_csrf_missing');
  return csrfToken;
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
        throw new Error(`hosted_e2e_phase8_control_state_unavailable:${response.status}`);
      }
      return body;
    },
    { csrfToken, teamId: runtime.teamId, workspaceId: runtime.workspaceId }
  );
}

async function lifecycleCommand(
  page: Page,
  input: {
    action: 'launch' | 'stop';
    csrfToken: string;
    expectedRevision: string;
    runId: string | null;
  }
): Promise<LifecycleCommandReceipt> {
  return page.evaluate(
    async ({ action, csrfToken, expectedRevision, runId, teamId, workspaceId }) => {
      const nonce = crypto.randomUUID().replaceAll('-', '');
      const response = await fetch(`/api/hosted/v1/team-lifecycle/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: `lifecycle-command_phase8-${action}-${nonce}`,
          idempotencyKey: `idempotency_phase8-${action}-${nonce}`,
          teamId,
          workspaceId,
          expectedRevision,
          ...(action === 'stop' ? { runId } : {}),
        }),
      });
      if (response.status !== 202) {
        throw new Error(`hosted_e2e_phase8_lifecycle_${action}_failed:${response.status}`);
      }
      const body = (await response.json()) as LifecycleCommandReceipt;
      if (
        body.kind !== 'accepted' ||
        typeof body.resourceRevision !== 'string' ||
        typeof body.runId !== 'string'
      ) {
        throw new Error(`hosted_e2e_phase8_lifecycle_${action}_receipt_invalid`);
      }
      return body;
    },
    { ...input, teamId: runtime.teamId, workspaceId: runtime.workspaceId }
  );
}

async function lifecycleProgress(
  page: Page,
  csrfToken: string
): Promise<LifecycleProvisioningStatus> {
  return page.evaluate(
    async ({ csrfToken, teamId, workspaceId }) => {
      const response = await fetch('/api/hosted/v1/team-lifecycle/progress', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
        body: JSON.stringify({ schemaVersion: 1, teamId, workspaceId }),
      });
      const body = (await response.json()) as LifecycleProvisioningStatus;
      if (response.status !== 200 || body.kind !== 'provisioning_status') {
        throw new Error(`hosted_e2e_phase8_progress_unavailable:${response.status}`);
      }
      return body;
    },
    { csrfToken, teamId: runtime.teamId, workspaceId: runtime.workspaceId }
  );
}

async function ensureStopped(page: Page, csrfToken: string): Promise<LifecycleControlState> {
  let control = await lifecycleControlState(page, csrfToken);
  if (control.availableActions.includes('stop')) {
    if (control.runId === null) throw new Error('hosted_e2e_phase8_running_team_missing_run');
    const receipt = await lifecycleCommand(page, {
      action: 'stop',
      csrfToken,
      expectedRevision: control.resourceRevision,
      runId: control.runId,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      control = await lifecycleControlState(page, csrfToken);
      if (
        control.resourceRevision === receipt.resourceRevision &&
        control.runId === null &&
        control.availableActions.includes('launch')
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('hosted_e2e_phase8_stop_convergence_timeout');
      }
      await page.waitForTimeout(100);
    }
  }
  if (control.runId !== null || !control.availableActions.includes('launch')) {
    throw new Error('hosted_e2e_phase8_stopped_state_invalid');
  }
  return control;
}

test('Phase 8 provider task external writes traverse production watcher, reconciler, composition, and SSE', async ({
  browser,
}) => {
  test.setTimeout(2 * 60_000);
  let ui: Awaited<ReturnType<typeof openAuthenticatedTeam>> | null = null;
  let observer: Awaited<ReturnType<typeof openAuthenticatedEventObserver>> | null = null;
  try {
    ui = await openAuthenticatedTeam(browser);
    observer = await openAuthenticatedEventObserver(browser);
    const { event } = await beginSseObservation(
      observer.page,
      runtime.eventCursor,
      'team.task.external_file_observed'
    );
    await writeProviderTask({
      claudeDir: runtime.claudeDir,
      teamName: runtime.teamName,
      taskId: 'provider-external-write',
      subject: 'Provider-side external task write',
    });
    await expect(ui.page.getByText('Provider-side external task write')).toBeVisible({
      timeout: 30_000,
    });
    await expect(event).resolves.toMatchObject({
      eventType: 'coordination_event',
      data: { eventType: 'team.task.external_file_observed' },
    });
  } finally {
    await Promise.allSettled(
      [observer?.context, ui?.context]
        .filter((context): context is BrowserContext => context !== undefined)
        .map((context) => context.close())
    );
  }
});

test('Phase 8 provider inbox external writes traverse production watcher, reconciler, composition, and SSE', async ({
  browser,
}) => {
  test.setTimeout(2 * 60_000);
  let ui: Awaited<ReturnType<typeof openAuthenticatedTeam>> | null = null;
  let observer: Awaited<ReturnType<typeof openAuthenticatedEventObserver>> | null = null;
  try {
    ui = await openAuthenticatedTeam(browser);
    observer = await openAuthenticatedEventObserver(browser);
    const { event } = await beginSseObservation(
      observer.page,
      runtime.eventCursor,
      'team.message.external_inbox_observed'
    );
    await writeProviderInbox({
      claudeDir: runtime.claudeDir,
      teamName: runtime.teamName,
      recipient: 'user',
      message: 'Provider inbox external-write proof',
    });
    await expect(ui.page.getByText('Provider inbox external-write proof')).toBeVisible({
      timeout: 30_000,
    });
    await expect(event).resolves.toMatchObject({
      eventType: 'coordination_event',
      data: { eventType: 'team.message.external_inbox_observed' },
    });
  } finally {
    await Promise.allSettled(
      [observer?.context, ui?.context]
        .filter((context): context is BrowserContext => context !== undefined)
        .map((context) => context.close())
    );
  }
});

test('Phase 8 SSE replay survives a production controller restart with top-level eventType', async ({
  browser,
}) => {
  test.setTimeout(2 * 60_000);
  const { context, page } = await openAuthenticatedTeam(browser);
  const csrfToken = await authCsrf(page);
  try {
    const control = await ensureStopped(page, csrfToken);
    const eventPromise = nextSseEvent(page, runtime.eventCursor, 'team-lifecycle.run-accepted');
    await lifecycleCommand(page, {
      action: 'launch',
      csrfToken,
      expectedRevision: control.resourceRevision,
      runId: null,
    });
    await expect(eventPromise).resolves.toMatchObject({
      eventType: 'coordination_event',
      data: { eventType: 'team-lifecycle.run-accepted' },
    });
    await restartController();
    await expect
      .poll(() => page.goto(runtime.origin).then((response) => response?.status()))
      .toBe(200);
    await expect(
      nextSseEvent(page, runtime.eventCursor, 'team-lifecycle.run-accepted')
    ).resolves.toMatchObject({
      eventType: 'coordination_event',
      data: { eventType: 'team-lifecycle.run-accepted' },
    });
  } finally {
    await context.close();
  }
});

test('Phase 8 lifecycle recovery survives a lost response, renderer reload, reauthentication, and production controller restart', async ({
  browser,
}) => {
  test.setTimeout(3 * 60_000);
  const { context, page } = await openAuthenticatedTeam(browser);
  let csrfToken = await authCsrf(page);
  const commandId = `lifecycle-command_phase8-lost-${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    const control = await ensureStopped(page, csrfToken);
    await page.route('**/api/hosted/v1/team-lifecycle/launch', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      await route.abort('failed');
    });
    await expect(
      page.evaluate(
        async ({ commandId, csrfToken, expectedRevision, teamId, workspaceId }) => {
          await fetch('/api/hosted/v1/team-lifecycle/launch', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': csrfToken },
            body: JSON.stringify({
              schemaVersion: 1,
              commandId,
              idempotencyKey: `idempotency_${commandId}`,
              teamId,
              workspaceId,
              expectedRevision,
            }),
          });
        },
        {
          commandId,
          csrfToken,
          expectedRevision: control.resourceRevision,
          teamId: runtime.teamId,
          workspaceId: runtime.workspaceId,
        }
      )
    ).rejects.toThrow();
    await page.unroute('**/api/hosted/v1/team-lifecycle/launch');

    const recovered = await lifecycleProgress(page, csrfToken);
    expect(recovered.recentCommands).toContainEqual(
      expect.objectContaining({ commandId, action: 'launch' })
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    csrfToken = await authCsrf(page);
    expect((await lifecycleProgress(page, csrfToken)).recentCommands).toContainEqual(
      expect.objectContaining({ commandId })
    );

    await context.clearCookies({ name: '__Host-agent-teams-session' });
    csrfToken = await authCsrf(page);
    expect((await lifecycleProgress(page, csrfToken)).recentCommands).toContainEqual(
      expect.objectContaining({ commandId })
    );

    await restartController();
    await expect
      .poll(() => page.goto(runtime.origin).then((response) => response?.status()))
      .toBe(200);
    csrfToken = await authCsrf(page);
    expect((await lifecycleProgress(page, csrfToken)).recentCommands).toContainEqual(
      expect.objectContaining({ commandId })
    );
  } finally {
    await page.unroute('**/api/hosted/v1/team-lifecycle/launch');
    await context.close();
  }
});

test('Phase 8 production retention expiry emits resync and remains expired after restart', async ({
  browser,
}) => {
  test.setTimeout(3 * 60_000);
  const { context, page } = await openAuthenticatedTeam(browser);
  const csrfToken = await authCsrf(page);
  try {
    let control = await ensureStopped(page, csrfToken);
    const firstEventPromise = nextSseEvent(
      page,
      runtime.eventCursor,
      'team-lifecycle.run-accepted'
    );
    await lifecycleCommand(page, {
      action: 'launch',
      csrfToken,
      expectedRevision: control.resourceRevision,
      runId: null,
    });
    const firstEvent = await firstEventPromise;
    control = await ensureStopped(page, csrfToken);
    const secondEventPromise = nextSseEvent(page, firstEvent.id, 'team-lifecycle.run-accepted');
    await lifecycleCommand(page, {
      action: 'launch',
      csrfToken,
      expectedRevision: control.resourceRevision,
      runId: null,
    });
    const secondEvent = await secondEventPromise;
    control = await ensureStopped(page, csrfToken);
    const thirdEventPromise = nextSseEvent(page, secondEvent.id, 'team-lifecycle.run-accepted');
    await lifecycleCommand(page, {
      action: 'launch',
      csrfToken,
      expectedRevision: control.resourceRevision,
      runId: null,
    });
    await thirdEventPromise;

    const watermark = await waitForProductionCoordinationRetention(runtime.appDataDir);
    expect(watermark.retentionFloorSequence).toBe(watermark.highWatermarkSequence - 1);
    await expect(nextSseEvent(page, firstEvent.id)).resolves.toMatchObject({
      eventType: 'resync_required',
      data: { kind: 'resync_required', reason: 'cursor_expired' },
    });
    await restartController();
    await expect
      .poll(() => page.goto(runtime.origin).then((response) => response?.status()))
      .toBe(200);
    await expect(nextSseEvent(page, firstEvent.id)).resolves.toMatchObject({
      eventType: 'resync_required',
      data: { kind: 'resync_required', reason: 'cursor_expired' },
    });
  } finally {
    await context.close();
  }
});

test('Phase 8 production SSE bounds and closes a real slow browser consumer', async ({
  browser,
}) => {
  test.setTimeout(4 * 60_000);
  const { context, page } = await openAuthenticatedTeam(browser);
  let caddyPaused = false;
  try {
    await page.evaluate((cursor) => {
      const state = {
        ready: false,
        closed: false,
        error: null as string | null,
        resume: null as (() => void) | null,
      };
      (window as typeof window & { __hostedSlowConsumer?: typeof state }).__hostedSlowConsumer =
        state;
      void fetch(`/api/hosted/v1/events?after=${encodeURIComponent(cursor)}`, {
        credentials: 'include',
        headers: { accept: 'text/event-stream' },
      })
        .then(async (response) => {
          if (response.status !== 200 || response.body === null) {
            throw new Error(`slow-consumer-status:${response.status}`);
          }
          const reader = response.body.getReader();
          state.ready = true;
          await new Promise<void>((resolve) => {
            state.resume = resolve;
          });
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
          }
          state.closed = true;
        })
        .catch((error) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
    }, runtime.eventCursor);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = (
            window as typeof window & {
              __hostedSlowConsumer?: { ready: boolean; error: string | null };
            }
          ).__hostedSlowConsumer;
          return state === undefined ? null : { ready: state.ready, error: state.error };
        })
      )
      .toEqual({ ready: true, error: null });
    await setCaddyPaused(true);
    caddyPaused = true;
    await page.waitForTimeout(8_000);
    await setCaddyPaused(false);
    caddyPaused = false;
    await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __hostedSlowConsumer?: { resume: (() => void) | null };
        }
      ).__hostedSlowConsumer;
      if (state?.resume === null || state?.resume === undefined) {
        throw new Error('hosted_e2e_phase8_slow_consumer_not_ready');
      }
      state.resume();
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = (
              window as typeof window & {
                __hostedSlowConsumer?: {
                  ready: boolean;
                  closed: boolean;
                  error: string | null;
                };
              }
            ).__hostedSlowConsumer;
            return state === undefined
              ? null
              : { ready: state.ready, closed: state.closed, error: state.error };
          }),
        { timeout: 15_000 }
      )
      .toEqual({ ready: true, closed: true, error: null });
  } finally {
    await Promise.allSettled([...(caddyPaused ? [setCaddyPaused(false)] : []), context.close()]);
  }
});
