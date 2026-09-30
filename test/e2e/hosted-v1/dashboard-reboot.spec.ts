import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { rebootHostedDashboardStack } from '../../fixtures/hosted-v1/dashboardRestart';
import { DASHBOARD_B_PUBLIC_WORKSPACE_ID } from '../../fixtures/hosted-v1/dashboardSandbox';

interface RuntimeInput {
  readonly authMode: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly sandboxRoot: string;
  readonly workspaceId: string;
}

const runtimeFile = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimeFile) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8')) as RuntimeInput;
if (runtime.authMode !== 'personal') throw new Error('hosted_dashboard_requires_personal_mode');

async function readCsrf(page: Page): Promise<string> {
  const csrf = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
    const status = (await response.json()) as { csrfToken: string | null };
    return status.csrfToken;
  });
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
  if (!csrf) throw new Error('hosted_dashboard_csrf_missing');
  return csrf;
}

async function workspaceIds(page: Page): Promise<string[]> {
  const csrf = await readCsrf(page);
  const result = await page.evaluate(async (token) => {
    const response = await fetch('/api/hosted/v1/workspaces/list', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-agent-teams-csrf': token },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }, csrf);
  expect(result.status).toBe(200);
  expect(result.body.kind).toBe('workspace-list');
  return (result.body.workspaces as { workspaceId: string }[]).map((item) => item.workspaceId);
}

function bootstrapBinding(environment: NodeJS.ProcessEnv): {
  bootId: string;
  digest: string;
  mountGeneration: number;
} {
  const bootstrap = environment.E2E_LIFECYCLE_BOOTSTRAP;
  if (!bootstrap) throw new Error('hosted_dashboard_restart_bootstrap_missing');
  const document = JSON.parse(bootstrap) as {
    bootId: string;
    runtimeInstance: { bootId: string };
    workspaceManifest: {
      registrations: { mountBinding: { bootId: string; mountGeneration: number } }[];
    };
  };
  expect(document.bootId).toBe(environment.E2E_BOOT_ID);
  expect(document.runtimeInstance.bootId).toBe(document.bootId);
  expect(document.workspaceManifest.registrations).toHaveLength(3);
  const mountGeneration = document.workspaceManifest.registrations[0]?.mountBinding.mountGeneration;
  expect(mountGeneration).toBeGreaterThan(0);
  for (const registration of document.workspaceManifest.registrations) {
    expect(registration.mountBinding).toMatchObject({
      bootId: document.bootId,
      mountGeneration,
    });
  }
  return {
    bootId: document.bootId,
    digest: createHash('sha256').update(bootstrap).digest('hex'),
    mountGeneration,
  };
}

async function expectSignedAdmission(binding: ReturnType<typeof bootstrapBinding>): Promise<void> {
  const envelope = JSON.parse(
    await readFile(
      resolve(runtime.sandboxRoot, 'lifecycle-run', 'lifecycle-owner-admission.json'),
      'utf8'
    )
  ) as { payload?: string; authentication?: { algorithm?: string; signature?: string } };
  expect(envelope.authentication?.algorithm).toBe('ed25519');
  expect(envelope.authentication?.signature).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  expect(typeof envelope.payload).toBe('string');
  const payload = JSON.parse(envelope.payload as string) as {
    bootstrapBinding?: { bootId?: string; bootstrapDigest?: string; mountGeneration?: number };
  };
  expect(payload.bootstrapBinding).toMatchObject({
    bootId: binding.bootId,
    bootstrapDigest: binding.digest,
    mountGeneration: binding.mountGeneration,
  });
}

test('Dashboard distinct signed boot admits B and rollback hides it', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  if (!runtime.pairingCode) throw new Error('hosted_dashboard_pairing_code_missing');
  const markerDocument = JSON.parse(
    await readFile(resolve(runtime.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'), 'utf8')
  ) as { marker: string };
  const image = process.env.E2E_APP_IMAGE;
  const sourceHeadCommit = process.env.E2E_SOURCE_HEAD_COMMIT;
  const sourcePatchSha256 = process.env.E2E_SOURCE_PATCH_SHA256;
  if (!image || !sourceHeadCommit || !sourcePatchSha256) {
    throw new Error('hosted_dashboard_image_evidence_missing');
  }
  let environment: NodeJS.ProcessEnv = process.env;
  const initial = bootstrapBinding(environment);
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  expect(await workspaceIds(page)).toContain(runtime.workspaceId);
  expect(await workspaceIds(page)).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);

  const reboot = async (active: boolean): Promise<ReturnType<typeof bootstrapBinding>> => {
    const next = await rebootHostedDashboardStack({
      active,
      composeFile: runtime.composeFile,
      composeProject: runtime.composeProject,
      environment,
      image,
      marker: markerDocument.marker,
      sandboxRoot: runtime.sandboxRoot,
      sourceHeadCommit,
      sourcePatchSha256,
    });
    environment = next.environment;
    const binding = bootstrapBinding(environment);
    expect(binding.bootId).toBe(next.bootId);
    expect(binding.mountGeneration).toBe(next.mountGeneration);
    await expectSignedAdmission(binding);
    await page.reload({ waitUntil: 'domcontentloaded' });
    return binding;
  };

  const active = await reboot(true);
  expect(active.bootId).not.toBe(initial.bootId);
  expect(active.mountGeneration).toBe(initial.mountGeneration + 1);
  expect(await workspaceIds(page)).toEqual(
    expect.arrayContaining([runtime.workspaceId, DASHBOARD_B_PUBLIC_WORKSPACE_ID])
  );
  await expect(page.getByRole('button', { name: 'Workspace 2', exact: true })).toBeVisible();

  const rollback = await reboot(false);
  expect(rollback.bootId).not.toBe(active.bootId);
  expect(rollback.mountGeneration).toBe(active.mountGeneration + 1);
  expect(await workspaceIds(page)).toContain(runtime.workspaceId);
  expect(await workspaceIds(page)).not.toContain(DASHBOARD_B_PUBLIC_WORKSPACE_ID);
  await expect(page.getByRole('button', { name: 'Workspace 2', exact: true })).toHaveCount(0);
});
