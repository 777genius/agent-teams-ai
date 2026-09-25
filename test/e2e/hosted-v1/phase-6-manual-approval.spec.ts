import { readFile } from 'node:fs/promises';

import { expect, type Page, test } from '@playwright/test';

import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from '../../../src/features/team-configuration/main/adapters/input/http/hostedTeamConfigurationRoutes';
import {
  readHistoricalManualRecord,
  seedHistoricalManualRecord,
} from '../../fixtures/hosted-v1/manualApprovalRecord';

interface RuntimeInput {
  readonly appDataDir: string;
  readonly authMode: string;
  readonly fakeRuntimeStateFile: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly sandboxRoot: string;
  readonly workspaceId: string;
}

const runtimeFile = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimeFile) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8')) as RuntimeInput;

type BrowserResponse = { readonly status: number; readonly body: unknown };

async function post(
  page: Page,
  path: string,
  body: unknown,
  csrfToken?: string
): Promise<BrowserResponse> {
  return page.evaluate(
    async ({ path, body, csrfToken }) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken ? { 'x-agent-teams-csrf': csrfToken } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body, csrfToken }
  );
}

const unsupported = {
  schemaVersion: 1,
  kind: 'error',
  error: { code: 'unsupported', reason: 'team_configuration_unsupported' },
  retryable: false,
};

test('Hosted manual approval stays unavailable across browser boundaries', async ({ page }) => {
  test.setTimeout(90_000);
  if (runtime.authMode !== 'personal' || runtime.pairingCode === null) {
    throw new Error('hosted_e2e_manual_requires_personal_sandbox');
  }
  const implicitApprovalRequests: string[] = [];
  const implicitLifecycleMutations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/hosted/v1/team-approvals/')) {
      implicitApprovalRequests.push(path);
    }
    if (
      path === '/api/hosted/v1/team-lifecycle/prepare' ||
      path === '/api/hosted/v1/team-lifecycle/launch'
    ) {
      implicitLifecycleMutations.push(path);
    }
  });
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  const initialWorkspaceButton = page.getByRole('button', { name: 'Workspace 1', exact: true });
  await expect(initialWorkspaceButton).toBeVisible();
  await initialWorkspaceButton.click();
  await expect(page.getByRole('heading', { name: 'Create team draft' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /approval mode/iu })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /manual approval/iu })).toHaveCount(0);
  const csrfToken = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    const status = (await response.json()) as { csrfToken: string | null };
    if (response.status !== 200 || !status.csrfToken) throw new Error('manual_e2e_csrf_missing');
    return status.csrfToken;
  });

  const configuration = {
    schemaVersion: 1,
    toolApprovalMode: 'manual',
    lanes: [
      {
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: 'openai/gpt-6',
        members: [{ name: 'lead', prompt: 'Coordinate this synthetic team.' }],
      },
    ],
  } as const;
  const create = {
    schemaVersion: 1,
    workspaceId: runtime.workspaceId,
    idempotencyKey: 'idempotency_manual-negative-historical',
    name: 'Synthetic manual approval team',
    members: [{ name: 'lead' }],
    configuration,
  };
  const createPath = '/api/hosted/v1/team-configuration/draft/create';
  const updatePath = '/api/hosted/v1/team-configuration/draft/update';
  const savedPath = '/api/hosted/v1/team-configuration/saved-request';
  // Promotion is mounted, but an incomplete request must not mutate either draft.
  // Activation and manual-approval routes remain absent in this MVP.
  expect(HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS.map(({ path }) => path)).toEqual([
    '/api/hosted/v1/team-configuration/draft/promote',
    savedPath,
    createPath,
    updatePath,
    '/api/hosted/v1/team-configuration/draft/delete',
    '/api/hosted/v1/team-configuration/draft/publication',
    '/api/hosted/v1/team-configuration/draft/publication/recover',
  ]);
  const promotionPath = '/api/hosted/v1/team-configuration/draft/promote';
  const unmountedActivationPath = '/api/hosted/v1/team-configuration/draft/activate';
  const runtimeBefore = await readFile(runtime.fakeRuntimeStateFile, 'utf8');

  // The rejected manual request must leave its idempotency key free for this synthetic
  // historical record. A silent auto conversion would make the second request conflict.
  expect(await post(page, createPath, create, csrfToken)).toEqual({
    status: 422,
    body: unsupported,
  });
  const created = await post(
    page,
    createPath,
    {
      ...create,
      configuration: { ...configuration, toolApprovalMode: 'auto' },
    },
    csrfToken
  );
  expect(created.status).toBe(201);
  const createdBody = created.body as {
    kind: string;
    identity: { workspaceId: string; teamId: string };
    revision: string;
    outcome: string;
  };
  expect(createdBody).toMatchObject({ kind: 'created', outcome: 'created' });
  const identity = createdBody.identity;
  expect(
    (await post(page, promotionPath, { schemaVersion: 1, ...identity }, csrfToken)).status
  ).toBe(400);
  expect(
    (await post(page, unmountedActivationPath, { schemaVersion: 1, ...identity }, csrfToken)).status
  ).toBe(404);
  expect(await readFile(runtime.fakeRuntimeStateFile, 'utf8')).toBe(runtimeBefore);
  const update = (updates: unknown) =>
    post(
      page,
      updatePath,
      {
        schemaVersion: 1,
        ...identity,
        expectedRevision: createdBody.revision,
        updates,
      },
      csrfToken
    );
  expect(await update({ configuration })).toEqual({ status: 422, body: unsupported });
  const beforeSeed = await post(page, savedPath, { schemaVersion: 1, ...identity });
  expect(beforeSeed.body).toMatchObject({
    kind: 'found',
    draft: { revision: createdBody.revision, configuration: { toolApprovalMode: 'auto' } },
  });

  const recordInput = {
    sandboxRoot: runtime.sandboxRoot,
    appDataDir: runtime.appDataDir,
    ...identity,
  };
  const historical = await seedHistoricalManualRecord(recordInput);
  expect(JSON.parse(historical.draft.members_json).configuration.toolApprovalMode).toBe('manual');
  expect(historical.draft.revision_token).toBe(createdBody.revision);
  expect(historical.createKeys).toHaveLength(1);
  expect(historical.publications).toHaveLength(1);
  expect(historical.promotions).toHaveLength(0);
  const readable = await post(page, savedPath, { schemaVersion: 1, ...identity });
  expect(readable).toMatchObject({
    status: 200,
    body: { kind: 'found', draft: { ...identity, revision: createdBody.revision, configuration } },
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const workspaceButton = page.getByRole('button', { name: 'Workspace 1', exact: true });
  await expect(workspaceButton).toBeVisible();
  await workspaceButton.click();
  const manualTeamRow = page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${identity.teamId}"]`
  );
  await expect(manualTeamRow).toHaveCount(1);
  await manualTeamRow.getByRole('button').click();
  await expect(
    page.getByText('This saved draft uses manual approval.', { exact: false })
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: /approval mode/iu })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /manual approval/iu })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(?:promote|activate)$/iu })).toHaveCount(0);
  await expect(page.getByLabel('Team description')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  expect(implicitApprovalRequests).toEqual([]);
  expect(implicitLifecycleMutations).toEqual([]);
  expect(await readHistoricalManualRecord(recordInput)).toEqual(historical);

  for (const updates of [
    { description: 'Forbidden metadata edit' },
    { configuration: { ...configuration, toolApprovalMode: 'auto' } },
  ]) {
    expect(await update(updates)).toEqual({ status: 422, body: unsupported });
    expect(await readHistoricalManualRecord(recordInput)).toEqual(historical);
  }
  expect(await post(page, createPath, create, csrfToken)).toEqual({
    status: 422,
    body: unsupported,
  });
  expect(
    await post(
      page,
      createPath,
      {
        ...create,
        configuration: { ...configuration, toolApprovalMode: 'auto' },
      },
      csrfToken
    )
  ).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
  expect(await readHistoricalManualRecord(recordInput)).toEqual(historical);
  expect(await post(page, savedPath, { schemaVersion: 1, ...identity })).toEqual(readable);

  // The malformed request is rejected before promotion for the historical
  // manual record as well. This does not assert a mode-specific denial.
  expect(
    (await post(page, promotionPath, { schemaVersion: 1, ...identity }, csrfToken)).status
  ).toBe(400);
  expect(
    (await post(page, unmountedActivationPath, { schemaVersion: 1, ...identity }, csrfToken)).status
  ).toBe(404);
  for (const path of [
    '/api/hosted/v1/team-approvals/page',
    '/api/hosted/v1/team-approvals/preview',
    '/api/hosted/v1/team-approvals/decisions',
  ]) {
    expect(
      (await post(page, path, { schemaVersion: 1, ...identity }, csrfToken)).status,
      path
    ).toBe(404);
  }
  expect(await readHistoricalManualRecord(recordInput)).toEqual(historical);
  expect(await readFile(runtime.fakeRuntimeStateFile, 'utf8')).toBe(runtimeBefore);
  expect(implicitLifecycleMutations).toEqual([]);
  await expect(
    page.getByRole('button', { name: /^(?:allow|deny|approve) (?:tool|request)/iu })
  ).toHaveCount(0);
});
