import { createHash } from 'node:crypto';

import { type Browser, expect, type Page, test } from '@playwright/test';

import {
  atomicAnchoredPrivateFile,
  chmodAnchoredPrivateFile,
  withAnchoredOutputPath,
} from '../../../scripts/e2e/hosted-actual-owner/secure-files';
import {
  ActualOwnerScenarioDriver,
  loadActualOwnerRuntimeManifest,
} from '../fixtures/hosted-actual-owner/driver';

import type { ActualOwnerBrowserResults } from '../../../scripts/e2e/hosted-actual-owner/evidence';

const runtimeManifestPath = process.env.HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST;
if (!runtimeManifestPath) {
  throw new Error('HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST is required');
}
const manifest = await loadActualOwnerRuntimeManifest(runtimeManifestPath);
const driver = new ActualOwnerScenarioDriver(manifest, 60_000);
type MutableBrowserResults = {
  -readonly [Key in keyof ActualOwnerBrowserResults]?: ActualOwnerBrowserResults[Key];
};
const results: MutableBrowserResults = { schemaVersion: 1 };

async function writeResults(): Promise<void> {
  if (!results.ownerAllow || !results.ownerDeny || !results.nonOwner || !results.ambiguous) {
    throw new Error('hosted_actual_owner_browser_results_incomplete');
  }
  results.ownerWalAuthority = await driver.ownerWalAuthority();
  await atomicAnchoredPrivateFile(
    manifest.browser.resultsPath,
    Buffer.from(`${JSON.stringify(results, null, 2)}\n`, 'utf8')
  );
}

async function ownerContext(browser: Browser) {
  return browser.newContext({
    baseURL: manifest.productBaseUrl,
    ignoreHTTPSErrors: true,
    storageState: manifest.browser.ownerStorageStatePath,
  });
}

async function clickDecision(
  page: Page,
  approval: Awaited<ReturnType<ActualOwnerScenarioDriver['startCase']>>,
  buttonName: string
): Promise<{ readonly bodySha256: string; readonly clickedAt: string }> {
  const clickedAt = new Date().toISOString();
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => {
      const url = new URL(candidate.url());
      return candidate.method() === 'POST' && url.pathname === approval.decisionPath;
    }),
    page.getByRole('button', { name: buttonName, exact: true }).click(),
  ]);
  const body = request.postDataBuffer();
  if (!body) throw new Error('hosted_actual_owner_browser_decision_body_missing');
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  if (bodySha256 !== approval.decisionRequestSha256) {
    throw new Error('hosted_actual_owner_browser_decision_body_mismatch');
  }
  return Object.freeze({ bodySha256, clickedAt });
}

test.describe.serial('real sandbox actual-owner approval', () => {
  test.beforeAll(async () => {
    await driver.assertCapability();
  });

  test.afterAll(async () => {
    await writeResults();
  });

  test('pending is durable across restart before the actual owner allows exactly once', async ({
    browser,
  }) => {
    const approval = await driver.startCase('allow');
    await driver.waitForCaseState(approval.approvalId, 'pending_durable');
    await driver.restartPending(approval.approvalId);
    await driver.waitForCaseState(approval.approvalId, 'pending_durable_after_restart');

    const context = await ownerContext(browser);
    await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
    try {
      const page = await context.newPage();
      await page.goto(manifest.approvalPath);
      await expect(page.getByRole('heading', { name: 'Pending approvals' })).toBeVisible();
      const click = await clickDecision(page, approval, `Allow: ${approval.summary}`);
      await driver.waitForCaseState(approval.approvalId, 'reconciled_terminal');
      results.ownerAllow = Object.freeze({
        actionNonceSha256: approval.actionNonceSha256,
        approvalId: approval.approvalId,
        bodySha256: click.bodySha256,
        clicked: true,
        clickedAt: click.clickedAt,
        decision: 'allow_once',
        effectId: approval.effectId,
        generation: approval.generation,
        pendingAfterRestart: true,
        requestId: approval.requestId,
        routeId: approval.routeId,
        runId: approval.runId,
        sessionId: approval.sessionId,
      });
    } finally {
      await withAnchoredOutputPath(manifest.browser.tracePath, (path) =>
        context.tracing.stop({ path })
      );
      await chmodAnchoredPrivateFile(manifest.browser.tracePath);
      await context.close();
    }
  });

  test('actual owner denies through the real browser surface', async ({ browser }) => {
    const approval = await driver.startCase('deny');
    await driver.waitForCaseState(approval.approvalId, 'pending_durable');
    const context = await ownerContext(browser);
    try {
      const page = await context.newPage();
      await page.goto(manifest.approvalPath);
      const click = await clickDecision(page, approval, `Deny: ${approval.summary}`);
      await driver.waitForCaseState(approval.approvalId, 'reconciled_terminal');
      results.ownerDeny = Object.freeze({
        actionNonceSha256: approval.actionNonceSha256,
        approvalId: approval.approvalId,
        bodySha256: click.bodySha256,
        clicked: true,
        clickedAt: click.clickedAt,
        decision: 'reject',
        effectId: approval.effectId,
        generation: approval.generation,
        requestId: approval.requestId,
        routeId: approval.routeId,
        runId: approval.runId,
        sessionId: approval.sessionId,
      });
    } finally {
      await context.close();
    }
  });

  test('authenticated non-owner is forbidden with zero provider effect', async ({ browser }) => {
    const approval = await driver.startCase('non_owner');
    await driver.waitForCaseState(approval.approvalId, 'pending_durable');
    const context = await browser.newContext({
      baseURL: manifest.productBaseUrl,
      ignoreHTTPSErrors: true,
      storageState: manifest.browser.nonOwnerStorageStatePath,
    });
    try {
      const page = await context.newPage();
      await page.goto(manifest.approvalPath);
      const status = await page.evaluate(
        async ({ decisionPath, decisionRequest }) => {
          const auth = await fetch('/api/auth/status', {
            credentials: 'same-origin',
            redirect: 'manual',
          });
          const body = (await auth.json()) as { readonly csrfToken?: unknown };
          if (typeof body.csrfToken !== 'string') throw new Error('non_owner_csrf_missing');
          const response = await fetch(decisionPath, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'manual',
            headers: {
              'content-type': 'application/json',
              'x-agent-teams-csrf': body.csrfToken,
            },
            body: JSON.stringify(decisionRequest),
          });
          return response.status;
        },
        { decisionPath: approval.decisionPath, decisionRequest: approval.decisionRequest }
      );
      expect(status).toBe(403);
      await driver.waitForCaseState(approval.approvalId, 'non_owner_forbidden');
      results.nonOwner = Object.freeze({ status: 403, postDelta: 0, effectDelta: 0 });
    } finally {
      await context.close();
    }
  });

  test('ambiguous after-effect remains operator_required and all restart/negative fences hold', async ({
    browser,
  }) => {
    const approval = await driver.startCase('ambiguous');
    await driver.waitForCaseState(approval.approvalId, 'pending_durable');
    const context = await ownerContext(browser);
    try {
      const page = await context.newPage();
      await page.goto(manifest.approvalPath);
      const click = await clickDecision(page, approval, `Allow: ${approval.summary}`);
      await driver.waitForCaseState(approval.approvalId, 'operator_required');
      await driver.assertAmbiguousNoRetry(approval.approvalId);
      results.ambiguous = Object.freeze({
        actionNonceSha256: approval.actionNonceSha256,
        approvalId: approval.approvalId,
        clicked: true,
        clickedAt: click.clickedAt,
        decision: 'allow_once',
        bodySha256: click.bodySha256,
        generation: approval.generation,
        effectId: approval.effectId,
        requestId: approval.requestId,
        routeId: approval.routeId,
        runId: approval.runId,
        sessionId: approval.sessionId,
        status: 'operator_required',
        automaticRetryPostDelta: 0,
      });
    } finally {
      await context.close();
    }
    await driver.runRestartMatrix();
    await driver.runNegativeMatrix();
  });
});
