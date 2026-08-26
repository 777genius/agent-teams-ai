import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type APIResponse, chromium, expect, test } from '@playwright/test';

type BrowserManifest = Readonly<{
  schemaVersion: 1;
  purpose: 'agent-teams.hosted-actual-owner-e2e.browser/v1';
  nonce: string;
  productOrigin: string;
  chromiumExecutable: string;
  ownerStorageState: string;
  nonOwnerStorageState: string;
  teamA: string;
  runA: string;
  teamB: string;
  runB: string;
  csrfHeader: string;
  csrfToken: string;
  evidenceRoot: string;
  resultsPath: string;
}>;

const manifestPath = process.env.HOSTED_ACTUAL_OWNER_E2E_BROWSER_MANIFEST;
if (!manifestPath) throw new Error('actual_owner_browser_manifest_missing');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BrowserManifest;
const rawPath = join(manifest.evidenceRoot, 'browser-http.ndjson');

async function rawResponse(response: APIResponse): Promise<Record<string, unknown>> {
  return {
    url: response.url(),
    status: response.status(),
    headers: response.headers(),
    body: await response.text(),
  };
}

async function record(
  scenario: 'allow' | 'deny' | 'stale' | 'replay' | 'cross-team',
  recordId: string,
  response: APIResponse,
  passed: boolean
): Promise<void> {
  await appendFile(
    rawPath,
    `${JSON.stringify({
      schemaVersion: 1,
      scenario,
      recordId,
      passed,
      effectCount: 0,
      raw: await rawResponse(response),
    })}\n`,
    { mode: 0o600 }
  );
}

test('real browser drives actual-owner approval decisions and rejections', async () => {
  test.setTimeout(180_000);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.purpose).toBe('agent-teams.hosted-actual-owner-e2e.browser/v1');
  const browser = await chromium.launch({
    executablePath: manifest.chromiumExecutable,
    headless: true,
  });
  try {
    const owner = await browser.newContext({
      storageState: manifest.ownerStorageState,
      baseURL: manifest.productOrigin,
    });
    const nonOwner = await browser.newContext({
      storageState: manifest.nonOwnerStorageState,
      baseURL: manifest.productOrigin,
    });
    const headers = { Origin: manifest.productOrigin, [manifest.csrfHeader]: manifest.csrfToken };
    const pageBody = {
      schemaVersion: 1,
      teamId: manifest.teamA,
      expectedRunId: manifest.runA,
      cursor: null,
      limit: 50,
    };
    let items: Record<string, unknown>[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && items.length < 2) {
      const response = await owner.request.post('/api/hosted/v1/team-approvals/page', {
        data: pageBody,
        headers,
      });
      if (response.status() === 200) {
        const body = (await response.json()) as { items?: Record<string, unknown>[] };
        items = body.items ?? [];
      }
      if (items.length < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    expect(items.length).toBeGreaterThanOrEqual(2);
    const [allowItem, denyItem] = items;
    const decide = (item: Record<string, unknown>, decision: 'allow' | 'deny', nonce: string) => ({
      schemaVersion: 1,
      teamId: manifest.teamA,
      expectedRunId: manifest.runA,
      approvalId: item.approvalId,
      expectedGeneration: item.generation,
      idempotencyKey: `actual-owner:${manifest.nonce}:${nonce}`,
      decision,
    });
    const allowCommand = decide(allowItem, 'allow', 'allow');
    const allow = await owner.request.post('/api/hosted/v1/team-approvals/decisions', {
      data: allowCommand,
      headers,
    });
    await record('allow', `allow:${manifest.nonce}`, allow, allow.status() === 200);
    expect(allow.status()).toBe(200);
    const replay = await owner.request.post('/api/hosted/v1/team-approvals/decisions', {
      data: allowCommand,
      headers,
    });
    const replayBody = await replay.text();
    await appendFile(
      rawPath,
      `${JSON.stringify({
        schemaVersion: 1,
        scenario: 'replay',
        recordId: `replay:${manifest.nonce}`,
        passed: replay.status() === 200 && replayBody.includes('idempotent_replay'),
        effectCount: 0,
        raw: {
          url: replay.url(),
          status: replay.status(),
          headers: replay.headers(),
          body: replayBody,
        },
      })}\n`,
      { mode: 0o600 }
    );
    expect(replayBody).toContain('idempotent_replay');
    const staleCommand = {
      ...decide(denyItem, 'deny', 'stale'),
      expectedGeneration: 'generation_stale',
    };
    const stale = await owner.request.post('/api/hosted/v1/team-approvals/decisions', {
      data: staleCommand,
      headers,
    });
    await record('stale', `stale:${manifest.nonce}`, stale, stale.status() === 409);
    expect(stale.status()).toBe(409);
    const denied = await owner.request.post('/api/hosted/v1/team-approvals/decisions', {
      data: decide(denyItem, 'deny', 'deny'),
      headers,
    });
    await record('deny', `deny:${manifest.nonce}`, denied, denied.status() === 200);
    expect(denied.status()).toBe(200);
    const crossTeam = await nonOwner.request.post('/api/hosted/v1/team-approvals/page', {
      data: { ...pageBody, teamId: manifest.teamB, expectedRunId: manifest.runB },
      headers,
    });
    await record(
      'cross-team',
      `cross-team:${manifest.nonce}`,
      crossTeam,
      [401, 403, 404].includes(crossTeam.status())
    );
    expect([401, 403, 404]).toContain(crossTeam.status());
    await Promise.all([owner.close(), nonOwner.close()]);
  } finally {
    await browser.close();
  }
});
