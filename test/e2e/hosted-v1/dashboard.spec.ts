import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, type Page, type Request, test } from '@playwright/test';

import { assertHostedV1MarkerOwnedRoot, E2E_TEAM_ID } from '../../fixtures/hosted-v1/createSandbox';
import { rebootHostedDashboardStack } from '../../fixtures/hosted-v1/dashboardRestart';
import {
  DASHBOARD_B_PUBLIC_WORKSPACE_ID,
  DASHBOARD_B_TEAM_ID,
  DASHBOARD_B_TEAM_NAME,
  DASHBOARD_C_PUBLIC_WORKSPACE_ID,
} from '../../fixtures/hosted-v1/dashboardSandbox';

interface RuntimeInput {
  readonly authMode: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly projectWorkspaceId: string;
  readonly sandboxRoot: string;
  readonly workspaceId: string;
}

const runtimeFile = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimeFile) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8')) as RuntimeInput;
if (runtime.authMode !== 'personal') throw new Error('hosted_dashboard_requires_personal_mode');

interface ProbeResult {
  readonly status: number;
  readonly rawBody: string;
  readonly body: Record<string, unknown>;
}

async function query(page: Page, path: string, body: object, csrf: string): Promise<ProbeResult> {
  return page.evaluate(
    async ({ path, body, csrf }) => {
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
      const rawBody = await response.text();
      if (rawBody.length > 65_536) throw new Error('hosted_dashboard_probe_response_too_large');
      return {
        status: response.status,
        rawBody,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      };
    },
    { path, body, csrf }
  );
}

async function registry(page: Page, csrf: string): Promise<ProbeResult> {
  return query(page, '/api/hosted/v1/workspaces/list', { schemaVersion: 1 }, csrf);
}

async function recent(page: Page, csrf: string): Promise<ProbeResult> {
  return query(page, '/api/hosted/v1/dashboard/recent-projects', { schemaVersion: 1 }, csrf);
}

function workspaceIds(result: ProbeResult): string[] {
  expect(result.status).toBe(200);
  expect(result.body.kind).toBe('workspace-list');
  return (result.body.workspaces as { workspaceId: string }[]).map((item) => item.workspaceId);
}

function recentIds(result: ProbeResult): string[] {
  expect(result.status).toBe(200);
  expect(result.body.kind).toBe('recent-projects');
  expect(result.rawBody).not.toContain('/workspaces/');
  return (result.body.projects as { workspaceId: string }[]).map((item) => item.workspaceId);
}

function observedSources(
  result: ProbeResult,
  workspaceId: string
): { provider: string; observedAt: number }[] {
  expect(result.status).toBe(200);
  const project = (
    result.body.projects as {
      workspaceId: string;
      sources: { provider: string; observedAt: number }[];
    }[]
  ).find((item) => item.workspaceId === workspaceId);
  expect(project).toBeDefined();
  return (project?.sources ?? [])
    .map(({ provider, observedAt }) => ({ provider, observedAt }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

async function readCsrf(page: Page): Promise<string> {
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    return response.json() as Promise<{ csrfToken: string | null }>;
  });
  expect(status.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
  if (!status.csrfToken) throw new Error('hosted_dashboard_csrf_missing');
  return status.csrfToken;
}

test('Dashboard staged A-only, exact-image B activation, read-only B and rollback', async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  if (!runtime.pairingCode) throw new Error('hosted_dashboard_pairing_code_missing');
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  let csrf = await readCsrf(page);

  const markerDocument = JSON.parse(
    await readFile(resolve(runtime.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'), 'utf8')
  ) as { marker: string };
  let environment: NodeJS.ProcessEnv = process.env;
  const image = environment.E2E_APP_IMAGE;
  const sourceHeadCommit = environment.E2E_SOURCE_HEAD_COMMIT;
  const sourcePatchSha256 = environment.E2E_SOURCE_PATCH_SHA256;
  if (!image || !sourceHeadCommit || !sourcePatchSha256) {
    throw new Error('hosted_dashboard_image_evidence_missing');
  }
  const restart = async (active: boolean): Promise<void> => {
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

  const stagedRegistry = workspaceIds(await registry(page, csrf));
  expect(stagedRegistry).toContain(runtime.workspaceId);
  expect(stagedRegistry).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);
  const stagedRecent = recentIds(await recent(page, csrf));
  const stagedASources = observedSources(await recent(page, csrf), runtime.workspaceId);
  expect(stagedASources.map((source) => source.provider)).toEqual(['anthropic', 'codex']);
  expect(stagedRecent).toContain(runtime.workspaceId);
  expect(stagedRecent).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);
  expect(stagedRecent).not.toContain(DASHBOARD_C_PUBLIC_WORKSPACE_ID);
  const stagedB = await query(
    page,
    '/api/hosted/v1/workspaces/select',
    { schemaVersion: 1, workspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID },
    csrf
  );
  expect(stagedB.body.kind).toBe('error');
  expect(stagedB.body.code).toBe('not_found');
  const stagedDirectory = await query(
    page,
    '/api/teams/lifecycle/read/scoped',
    {
      schemaVersion: 1,
      publicWorkspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
      cursor: null,
      expectedRevision: null,
    },
    csrf
  );
  expect(stagedDirectory.body.kind).toBe('failure');

  await assertHostedV1MarkerOwnedRoot(
    runtime.sandboxRoot,
    resolve(runtime.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'),
    markerDocument.marker
  );
  const cActivityAt = new Date(Date.now() - 5_000).toISOString();
  await Promise.all([
    writeFile(
      resolve(
        runtime.sandboxRoot,
        'claude/projects/-workspaces-sandbox-private-c/00000000-0000-4000-8000-000000000003.jsonl'
      ),
      `${JSON.stringify({
        type: 'user',
        timestamp: cActivityAt,
        cwd: '/workspaces/sandbox/private-c',
        message: { content: 'denied C metadata changed' },
      })}\n`
    ),
    writeFile(
      resolve(runtime.sandboxRoot, 'codex-metadata/sessions/rollout-dashboard-c.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        timestamp: cActivityAt,
        payload: {
          id: 'dashboard-c',
          timestamp: cActivityAt,
          cwd: '/workspaces/sandbox/private-c',
          source: 'cli',
        },
      })}\n`
    ),
  ]);

  await restart(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    csrf = await readCsrf(page);
    const activeIds = workspaceIds(await registry(page, csrf));
    expect(activeIds).toEqual(
      expect.arrayContaining([runtime.workspaceId, DASHBOARD_B_PUBLIC_WORKSPACE_ID])
    );
    expect(activeIds).not.toContain(DASHBOARD_C_PUBLIC_WORKSPACE_ID);
    const deniedC = await query(
      page,
      '/api/hosted/v1/workspaces/select',
      { schemaVersion: 1, workspaceId: DASHBOARD_C_PUBLIC_WORKSPACE_ID },
      csrf
    );
    expect(deniedC.body.kind).toBe('error');
    const activeRecent = await recent(page, csrf);
    expect(observedSources(activeRecent, runtime.workspaceId)).toEqual(stagedASources);
    expect(recentIds(activeRecent)).toEqual(
      expect.arrayContaining([runtime.workspaceId, DASHBOARD_B_PUBLIC_WORKSPACE_ID])
    );
    for (const project of activeRecent.body.projects as {
      workspaceId: string;
      sources: { provider: string }[];
    }[]) {
      expect(project.sources.map((source) => source.provider)).toEqual(
        expect.arrayContaining(['anthropic', 'codex'])
      );
    }
    expect((await recent(page, csrf)).rawBody).not.toContain(DASHBOARD_C_PUBLIC_WORKSPACE_ID);
    const selectedB = await query(
      page,
      '/api/hosted/v1/workspaces/select',
      { schemaVersion: 1, workspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID },
      csrf
    );
    expect(selectedB.status).toBe(200);
    expect(selectedB.body.kind).toBe('workspace-selection');
    const access = await query(
      page,
      '/api/hosted/v1/workspace-access/project',
      { publicWorkspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID },
      csrf
    );
    expect(access.status).toBe(200);
    expect(access.body.capabilities).toContain('directory.read');
    for (const forbidden of [
      'configuration.write',
      'promotion.execute',
      'lifecycle.command',
      'task.write',
      'message.send',
      'operator.control',
    ])
      expect(access.body.capabilities).not.toContain(forbidden);
    const directory = await query(
      page,
      '/api/teams/lifecycle/read/scoped',
      {
        schemaVersion: 1,
        publicWorkspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
        cursor: null,
        expectedRevision: null,
      },
      csrf
    );
    expect(directory.body.kind).toBe('success');
    expect(
      (directory.body.items as { teamId: string }[]).some(
        (item) => item.teamId === DASHBOARD_B_TEAM_ID
      )
    ).toBe(true);
    const teamAccess = await query(
      page,
      '/api/hosted/v1/workspace-access/project',
      {
        publicWorkspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID,
        publicTeamId: DASHBOARD_B_TEAM_ID,
      },
      csrf
    );
    expect(teamAccess.body.capabilities).toContain('team.open');
    expect(teamAccess.body.capabilities).toContain('task.read');
    expect(teamAccess.body.capabilities).toContain('message.read');
    await expect(page.locator('[data-recent-project-cell="project"]')).toHaveCount(2);
    const bReadRequests: string[] = [];
    const bWriteRequests: string[] = [];
    const readPaths = new Set([
      '/api/hosted/v1/team-task-board/page',
      '/api/hosted/v1/team-messages/page',
    ]);
    const writePaths = new Set([
      '/api/hosted/v1/team-task-board/mutations',
      '/api/hosted/v1/team-messages/send',
      '/api/hosted/v1/team-configuration/draft/create',
      '/api/hosted/v1/team-configuration/draft/update',
      '/api/hosted/v1/team-configuration/draft/delete',
      '/api/hosted/v1/team-configuration/draft/promote',
      '/api/hosted/v1/team-lifecycle/prepare',
      '/api/hosted/v1/team-lifecycle/launch',
      '/api/hosted/v1/team-lifecycle/cancel',
      '/api/hosted/v1/team-lifecycle/stop',
      '/api/hosted/v1/team-lifecycle/recover',
    ]);
    const onBRequest = (request: Request): void => {
      if (request.method() !== 'POST') return;
      const url = new URL(request.url());
      if (url.origin !== runtime.origin) return;
      if (readPaths.has(url.pathname)) bReadRequests.push(url.pathname);
      if (writePaths.has(url.pathname)) bWriteRequests.push(url.pathname);
    };
    page.on('request', onBRequest);
    await page
      .locator('[data-recent-project-cell="project"]')
      .filter({ hasText: 'Workspace 2' })
      .getByRole('button')
      .click();
    await expect(page.getByRole('button', { name: 'Workspace 2', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const teamRow = page.locator(
      `[data-testid="hosted-team-lifecycle-row"][data-team-id="${DASHBOARD_B_TEAM_ID}"]`
    );
    await expect(teamRow).toBeVisible();
    await teamRow.getByRole('button').click();
    await expect(teamRow.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    const taskBoard = page.getByRole('region', { name: 'Selected team task board' });
    await expect(taskBoard).toContainText('Dashboard B read-only task');
    await expect(taskBoard.locator('[aria-label="Read-only task board"]')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Selected team messages' })).toBeVisible();
    await expect(page.locator('[data-testid="hosted-team-message-list"]')).toBeVisible();
    expect(bReadRequests).toEqual(expect.arrayContaining([...readPaths]));
    expect(bWriteRequests).toEqual([]);
    await expect(page.getByRole('button', { name: 'Create team' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save task' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'New message' })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Hosted operator controls' })).toHaveCount(
      0
    );

    await page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Workspace 1', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(teamRow).toHaveCount(0);
    await expect(taskBoard).not.toContainText('Dashboard B read-only task');
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+k');
    const workspacePalette = page.getByRole('dialog', { name: 'Find a workspace' });
    await expect(workspacePalette).toBeVisible();
    await workspacePalette.getByRole('button', { name: 'Workspace 2' }).click();
    const teamPalette = page.getByRole('dialog', { name: 'Find a team' });
    await expect(teamPalette).toBeVisible();
    await teamPalette.getByRole('button', { name: DASHBOARD_B_TEAM_NAME }).click();
    await expect(teamPalette).toHaveCount(0);
    await expect(teamRow.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(taskBoard).toContainText('Dashboard B read-only task');
    await expect(page.getByRole('complementary', { name: 'Selected team messages' })).toBeVisible();
    page.off('request', onBRequest);
  } finally {
    await restart(false);
  }
  await page.getByRole('button', { name: 'Refresh workspaces' }).click();
  await expect(page.getByRole('button', { name: 'Workspace 2', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Selected team task board' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  csrf = await readCsrf(page);
  expect(workspaceIds(await registry(page, csrf))).toContain(runtime.workspaceId);
  expect(workspaceIds(await registry(page, csrf))).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);
  expect(recentIds(await recent(page, csrf))).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);
  await expect(page.getByRole('button', { name: 'Workspace 2', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-recent-project-cell="project"]')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+k');
  const rolledBackPalette = page.getByRole('dialog', { name: 'Find a workspace' });
  await expect(rolledBackPalette).toBeVisible();
  await expect(rolledBackPalette.getByRole('button', { name: 'Workspace 2' })).toHaveCount(0);
  await expect(rolledBackPalette.getByRole('button', { name: 'Workspace 1' })).toBeVisible();
  await page.keyboard.press('Escape');
  const rolledBackB = await query(
    page,
    '/api/hosted/v1/workspaces/select',
    { schemaVersion: 1, workspaceId: DASHBOARD_B_PUBLIC_WORKSPACE_ID },
    csrf
  );
  expect(rolledBackB.body.kind).toBe('error');
  expect(rolledBackB.body.code).toBe('not_found');
  await page
    .locator('[data-recent-project-cell="project"]')
    .filter({ hasText: 'Workspace 1' })
    .getByRole('button')
    .click();
  const aTeamRow = page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${E2E_TEAM_ID}"]`
  );
  await expect(aTeamRow).toBeVisible();
  await aTeamRow.getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Selected team task board' })).toContainText(
    'Marker-owned browser E2E task'
  );
});
