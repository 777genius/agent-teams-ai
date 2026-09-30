import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { rebootHostedDashboardStack } from '../../fixtures/hosted-v1/dashboardRestart';
import {
  DASHBOARD_B_PUBLIC_WORKSPACE_ID,
  DASHBOARD_B_RUNTIME_WORKSPACE_ID,
  DASHBOARD_B_TEAM_ID,
  DASHBOARD_B_TEAM_NAME,
} from '../../fixtures/hosted-v1/dashboardSandbox';

interface RuntimeInput {
  readonly authMode: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly claudeDir: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly sandboxRoot: string;
  readonly teamId: string;
  readonly workspaceId: string;
}

interface ProbeResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runtimeFile = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimeFile) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8')) as RuntimeInput;
if (runtime.authMode !== 'personal') throw new Error('hosted_dashboard_security_requires_personal_mode');

async function post(page: Page, path: string, body: object, csrf: string): Promise<ProbeResult> {
  return page.evaluate(async ({ path, body, csrf }) => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-agent-teams-csrf': csrf,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (text.length > 65_536) throw new Error('hosted_dashboard_security_response_too_large');
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  }, { path, body, csrf });
}

async function csrfToken(page: Page): Promise<string> {
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    return response.json() as Promise<{ csrfToken: string | null }>;
  });
  expect(status.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
  if (!status.csrfToken) throw new Error('hosted_dashboard_security_csrf_missing');
  return status.csrfToken;
}

async function bReadState(page: Page, csrf: string): Promise<{
  readonly tasks: unknown;
  readonly messages: unknown;
  readonly sourceGeneration: string;
  readonly revision: string;
}> {
  const pageBody = {
    schemaVersion: 1,
    teamId: DASHBOARD_B_TEAM_ID,
    cursor: null,
    expectedSourceGeneration: null,
    limit: 50,
  };
  const tasks = await post(page, '/api/hosted/v1/team-task-board/page', pageBody, csrf);
  const messages = await post(page, '/api/hosted/v1/team-messages/page', pageBody, csrf);
  expect(tasks.status).toBe(200);
  expect(messages.status).toBe(200);
  expect(tasks.body.kind).toBe('task_board_page');
  expect(messages.body.kind).toBe('message_page');
  expect(tasks.body.sourceGeneration).toMatch(/^generation_/u);
  expect(tasks.body.revision).toMatch(/^revision_/u);
  expect(tasks.body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: 'Dashboard B read-only task' }),
  ]));
  return {
    tasks: tasks.body.items,
    messages: messages.body.messages,
    sourceGeneration: tasks.body.sourceGeneration as string,
    revision: tasks.body.revision as string,
  };
}

test('Dashboard forged B write attempts are fenced while A owner-bound draft write works', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  if (!runtime.pairingCode) throw new Error('hosted_dashboard_security_pairing_code_missing');
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();

  const markerDocument = JSON.parse(
    await readFile(resolve(runtime.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'), 'utf8')
  ) as { marker: string };
  let environment: NodeJS.ProcessEnv = process.env;
  const image = environment.E2E_APP_IMAGE;
  const sourceHeadCommit = environment.E2E_SOURCE_HEAD_COMMIT;
  const sourcePatchSha256 = environment.E2E_SOURCE_PATCH_SHA256;
  if (!image || !sourceHeadCommit || !sourcePatchSha256) {
    throw new Error('hosted_dashboard_security_image_evidence_missing');
  }
  const reboot = async (active: boolean): Promise<void> => {
    const next = await rebootHostedDashboardStack({
      active,
      composeFile: runtime.composeFile,
      composeProject: runtime.composeProject,
      image,
      marker: markerDocument.marker,
      sandboxRoot: runtime.sandboxRoot,
      sourceHeadCommit,
      sourcePatchSha256,
      environment,
    });
    environment = next.environment;
  };

  await reboot(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const csrf = await csrfToken(page);
    const access = await post(page, '/api/hosted/v1/workspace-access/project', {
      publicWorkspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
      publicTeamId: DASHBOARD_B_TEAM_ID,
    }, csrf);
    expect(access.status).toBe(200);
    expect(access.body.capabilities).toContain('team.open');
    for (const capability of [
      'configuration.write', 'promotion.execute', 'lifecycle.command',
      'task.write', 'message.send', 'operator.control',
    ]) expect(access.body.capabilities).not.toContain(capability);
    const aLifecycleRequest = {
      schemaVersion: 1, workspaceId: runtime.workspaceId, teamId: runtime.teamId,
    };
    await expect.poll(async () =>
      (await post(page, '/api/hosted/v1/team-lifecycle/control-state', aLifecycleRequest, csrf)).status,
      { timeout: 30_000 }
    ).toBe(200);
    const aLifecycle = await post(
      page, '/api/hosted/v1/team-lifecycle/control-state', aLifecycleRequest, csrf
    );
    expect(aLifecycle.status).toBe(200);
    expect(aLifecycle.body).toMatchObject({
      kind: 'control_state', workspaceId: runtime.workspaceId, teamId: runtime.teamId,
    });
    const before = await bReadState(page, csrf);
    const bFixturePaths = [
      join(runtime.claudeDir, 'teams', DASHBOARD_B_TEAM_NAME, 'config.json'),
      join(runtime.claudeDir, 'tasks', DASHBOARD_B_TEAM_NAME, '1.json'),
    ];
    const bFixtureBefore = await Promise.all(bFixturePaths.map((path) => readFile(path)));

    const forged: readonly {
      readonly label: string;
      readonly path: string;
      readonly body: object;
      readonly allowedStatuses: readonly number[];
    }[] = [
      {
        label: 'configuration runtime workspace',
        path: '/api/hosted/v1/team-configuration/draft/create',
        body: {
          schemaVersion: 1, workspaceId: DASHBOARD_B_RUNTIME_WORKSPACE_ID,
          idempotencyKey: 'idempotency_dashboard-security-b-runtime',
          name: 'forged-dashboard-b-runtime', members: [{ name: 'team-lead' }],
        },
        allowedStatuses: [403],
      },
      {
        label: 'configuration public workspace',
        path: '/api/hosted/v1/team-configuration/draft/create',
        body: {
          schemaVersion: 1, workspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
          idempotencyKey: 'idempotency_dashboard-security-b-public',
          name: 'forged-dashboard-b-public', members: [{ name: 'team-lead' }],
        },
        allowedStatuses: [403],
      },
      {
        label: 'promotion',
        path: '/api/hosted/v1/team-configuration/draft/promote',
        body: {
          schemaVersion: 1, workspaceId: DASHBOARD_B_RUNTIME_WORKSPACE_ID,
          teamId: DASHBOARD_B_TEAM_ID, expectedRevision: 'revision_dashboard-security-b',
          idempotencyKey: 'idempotency_dashboard-security-b-promote',
        },
        allowedStatuses: [403],
      },
      {
        label: 'lifecycle',
        path: '/api/hosted/v1/team-lifecycle/launch',
        body: {
          schemaVersion: 1, workspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
          teamId: DASHBOARD_B_TEAM_ID, expectedRevision: 'revision_dashboard-security-b',
          commandId: 'lifecycle-command_dashboard-security-b',
          idempotencyKey: 'idempotency_dashboard-security-b-launch',
        },
        allowedStatuses: [403, 404, 503],
      },
      {
        label: 'task',
        path: '/api/hosted/v1/team-task-board/mutations',
        body: {
          schemaVersion: 1, kind: 'create_task', teamId: DASHBOARD_B_TEAM_ID,
          commandId: 'command_dashboard-security-b-task',
          idempotencyKey: 'idempotency_dashboard-security-b-task',
          expectedSourceGeneration: before.sourceGeneration,
          expectedRevision: before.revision,
          subject: 'Forged dashboard B task', description: null, status: 'pending',
          ownerId: null, column: 'todo', order: 0,
        },
        allowedStatuses: [403, 404, 503],
      },
      {
        label: 'message',
        path: '/api/hosted/v1/team-messages/send',
        body: {
          schemaVersion: 1, teamId: DASHBOARD_B_TEAM_ID,
          clientMessageId: 'client_message_dashboard-security-b',
          text: 'Forged dashboard B message',
        },
        allowedStatuses: [403, 404, 503],
      },
      {
        label: 'operator approval decision',
        path: '/api/hosted/v1/team-approvals/decisions',
        body: {
          schemaVersion: 1, teamId: DASHBOARD_B_TEAM_ID,
          expectedRunId: `run_${'6'.repeat(32)}`,
          approvalId: `approval_${'6'.repeat(32)}`,
          expectedGeneration: 'generation_dashboard-security-b',
          idempotencyKey: 'idempotency_dashboard-security-b-approval',
          decision: 'deny',
        },
        allowedStatuses: [404],
      },
    ];
    for (const { label, path, body, allowedStatuses } of forged) {
      const result = await post(page, path, body, csrf);
      expect(allowedStatuses, label).toContain(result.status);
      expect(result.body, label).not.toHaveProperty('receipt');
      if (label.startsWith('configuration') || label === 'promotion') {
        expect(result.body, label).toMatchObject({
          kind: 'error', error: { code: 'forbidden' }, retryable: false,
        });
      } else if (result.status === 403) {
        expect(result.body, label).toEqual({ error: 'workspace_access_denied' });
      } else if (label === 'lifecycle' && result.status === 503) {
        expect(result.body, label).toMatchObject({ schemaVersion: 1, kind: 'unavailable' });
        expect(
          result.body.retryAfterMs === null ||
            (Number.isSafeInteger(result.body.retryAfterMs) &&
              (result.body.retryAfterMs as number) > 0),
          label
        ).toBe(true);
      } else if (label === 'lifecycle' && result.status === 404) {
        expect(result.body, label).toMatchObject({
          schemaVersion: 1, kind: 'not_found', action: 'launch',
          commandId: 'lifecycle-command_dashboard-security-b',
          teamId: DASHBOARD_B_TEAM_ID,
        });
      } else if (label === 'task' || label === 'message') {
        if (result.status === 503 || result.status === 404) {
          expect(result.body, label).toMatchObject({
            schemaVersion: 1,
            kind: 'error',
            error: {
              code: result.status === 503 ? 'unavailable' : 'not_found',
              reason: `${label === 'task' ? 'task_board' : 'team_message'}_${
                result.status === 503 ? 'unavailable' : 'not_found'
              }`,
            },
          });
        }
      }
    }
    expect(await bReadState(page, csrf)).toEqual(before);
    expect(await Promise.all(bFixturePaths.map((path) => readFile(path)))).toEqual(bFixtureBefore);

    const aDraft = await post(page, '/api/hosted/v1/team-configuration/draft/create', {
      schemaVersion: 1, workspaceId: runtime.workspaceId,
      idempotencyKey: 'idempotency_dashboard-security-a-owner',
      name: 'dashboard-security-a-owner', members: [{ name: 'team-lead' }],
    }, csrf);
    expect(aDraft.status).toBe(201);
    expect(aDraft.body).toMatchObject({
      kind: 'created', identity: { workspaceId: runtime.workspaceId }, outcome: 'created',
    });
    const identity = aDraft.body.identity as { workspaceId: string; teamId: string };
    const deleted = await post(page, '/api/hosted/v1/team-configuration/draft/delete', {
      schemaVersion: 1, ...identity, expectedRevision: aDraft.body.revision,
    }, csrf);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ kind: 'deleted', outcome: 'deleted', identity });
    const aBoard = await post(page, '/api/hosted/v1/team-task-board/page', {
      schemaVersion: 1, teamId: runtime.teamId, cursor: null,
      expectedSourceGeneration: null, limit: 50,
    }, csrf);
    expect(aBoard.status).toBe(200);
    expect(aBoard.body.kind).toBe('task_board_page');
    const aTask = await post(page, '/api/hosted/v1/team-task-board/mutations', {
      schemaVersion: 1, kind: 'create_task', teamId: runtime.teamId,
      commandId: 'command_dashboard-security-a-task',
      idempotencyKey: 'idempotency_dashboard-security-a-task',
      expectedSourceGeneration: aBoard.body.sourceGeneration,
      expectedRevision: aBoard.body.revision,
      subject: 'Dashboard security A owner task', description: null,
      status: 'pending', ownerId: null, column: 'todo', order: 0,
    }, csrf);
    expect(aTask.status).toBe(200);
    expect(aTask.body).toMatchObject({ outcome: 'committed' });
    const aMessage = await post(page, '/api/hosted/v1/team-messages/send', {
      schemaVersion: 1, teamId: runtime.teamId,
      clientMessageId: 'client_message_dashboard-security-a',
      text: 'Dashboard security A owner message',
    }, csrf);
    expect(aMessage.status).toBe(200);
    expect(aMessage.body).toMatchObject({
      kind: 'persisted', receipt: { teamId: runtime.teamId, persistence: 'durable' },
    });
    expect(await bReadState(page, csrf)).toEqual(before);
    expect(await Promise.all(bFixturePaths.map((path) => readFile(path)))).toEqual(bFixtureBefore);
  } finally {
    await reboot(false);
  }
});
