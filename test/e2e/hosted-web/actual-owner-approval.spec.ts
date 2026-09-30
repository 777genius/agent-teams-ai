import { randomBytes } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

import {
  canonicalJson,
  exactRecord,
  type MatrixRow,
  PRODUCT_ORIGIN,
  sha256,
} from '../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  canonicalRowIdentity,
  makeRawRecord,
  makeSemanticPayload,
  observedSemanticIdentity,
} from '../../../scripts/e2e/hosted-actual-owner/evidence';
import {
  productRunIdToProvenanceTeamRunId,
} from '../../../src/features/hosted-producer-provenance/main/hosted';
import { parseHostedTeamApprovalPage } from '../../../src/features/team-approvals/contracts/hosted';
import { createBrowserHostedProducerProvenanceFromEnvironment } from '../../../src/main/composition/hosted/hostedProducerProvenanceComposition';

const DESCRIPTOR_FD = 3;
const OBSERVATION_FD = 4;
const PROCESS_IDENTITY_FD = 5;

const browserProducerProvenance = (() => {
  const provenance = createBrowserHostedProducerProvenanceFromEnvironment(process.env, {
    modulePath: __filename,
  });
  if (provenance === null) throw new Error('p3c_browser_producer_provenance_required');
  return provenance;
})();

test.afterAll(() => {
  browserProducerProvenance.close();
});

interface ApprovalTarget {
  readonly approvalId: string;
  readonly generation: string;
  readonly idempotencyKey: string;
  readonly previewRef: string;
}

interface ObservedApprovalItem {
  readonly teamId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly generation: string;
  readonly category: 'file_change' | 'command' | 'network' | 'other';
  readonly summary: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly previewRef: string;
}

interface BrowserScenario {
  readonly controllerNonce: string;
  readonly origin: typeof PRODUCT_ORIGIN;
  readonly authenticatedActorTeamId: string;
  readonly targetTeamAId: string;
  readonly targetTeamBId: string;
  readonly teamARunId: string;
  readonly teamBRunId: string;
  readonly allow: ApprovalTarget;
  readonly deny: ApprovalTarget;
  readonly teamBRequest: ApprovalTarget;
  readonly processStartToken: string;
}

function canonicalFdJson(fd: number, label: string): Record<string, unknown> {
  const bytes = readFileSync(`/proc/self/fd/${fd}`);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(source) as unknown;
  if (canonicalJson(value) !== source) throw new Error(`p3c_browser_${label}_noncanonical`);
  return value as Record<string, unknown>;
}

function readScenario(): BrowserScenario {
  const descriptor = exactRecord(
    canonicalFdJson(DESCRIPTOR_FD, 'descriptor'),
    [
      'schemaVersion',
      'purpose',
      'controllerNonce',
      'origin',
      'matrixRows',
      'observationFd',
      'scenario',
      'playwright',
    ],
    'browser_descriptor'
  );
  const identity = exactRecord(
    canonicalFdJson(PROCESS_IDENTITY_FD, 'identity'),
    ['schemaVersion', 'purpose', 'controllerNonce', 'role', 'processStartToken'],
    'browser_identity'
  );
  const scenario = exactRecord(
    descriptor.scenario,
    [
      'authenticatedActorTeamId',
      'targetTeamAId',
      'targetTeamBId',
      'teamARunId',
      'teamBRunId',
      'allow',
      'deny',
      'teamBRequest',
    ],
    'browser_scenario'
  );
  const target = (value: unknown, label: string): ApprovalTarget => {
    const item = exactRecord(
      value,
      ['approvalId', 'generation', 'idempotencyKey', 'previewRef'],
      label
    );
    if (
      typeof item.approvalId !== 'string' ||
      !/^approval_[0-9a-f]{32}$/u.test(item.approvalId) ||
      typeof item.generation !== 'string' ||
      !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u.test(item.generation) ||
      typeof item.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.idempotencyKey) ||
      typeof item.previewRef !== 'string' ||
      !/^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(item.previewRef)
    )
      throw new Error(`p3c_browser_${label}_identity`);
    return Object.freeze({
      approvalId: item.approvalId,
      generation: item.generation,
      idempotencyKey: item.idempotencyKey,
      previewRef: item.previewRef,
    });
  };
  const allow = target(scenario.allow, 'allow');
  const deny = target(scenario.deny, 'deny');
  const teamBRequest = target(scenario.teamBRequest, 'team_b_request');
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.purpose !== 'agent-teams.p3c.browser-descriptor/v1' ||
    descriptor.origin !== PRODUCT_ORIGIN ||
    descriptor.observationFd !== OBSERVATION_FD ||
    identity.schemaVersion !== 1 ||
    identity.purpose !== 'agent-teams.p3c.process-identity/v1' ||
    identity.controllerNonce !== descriptor.controllerNonce ||
    identity.role !== 'browser' ||
    typeof descriptor.controllerNonce !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(descriptor.controllerNonce) ||
    typeof identity.processStartToken !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(identity.processStartToken) ||
    browserProducerProvenance.controllerNonce !== descriptor.controllerNonce ||
    browserProducerProvenance.runId !==
      sha256(`agent-teams.p3c.run/v1\0${descriptor.controllerNonce}`) ||
    typeof scenario.authenticatedActorTeamId !== 'string' ||
    !/^team_[0-9a-f]{32}$/u.test(scenario.authenticatedActorTeamId) ||
    scenario.authenticatedActorTeamId !== scenario.targetTeamAId ||
    typeof scenario.targetTeamBId !== 'string' ||
    !/^team_[0-9a-f]{32}$/u.test(scenario.targetTeamBId) ||
    scenario.targetTeamAId === scenario.targetTeamBId ||
    typeof scenario.teamARunId !== 'string' ||
    !/^run_[0-9a-f]{32}$/u.test(scenario.teamARunId) ||
    typeof scenario.teamBRunId !== 'string' ||
    !/^run_[0-9a-f]{32}$/u.test(scenario.teamBRunId) ||
    scenario.teamARunId === scenario.teamBRunId ||
    allow.approvalId === deny.approvalId ||
    allow.idempotencyKey === deny.idempotencyKey ||
    [allow.approvalId, deny.approvalId].includes(teamBRequest.approvalId)
  )
    throw new Error('p3c_browser_descriptor_binding');
  return Object.freeze({
    controllerNonce: descriptor.controllerNonce,
    origin: PRODUCT_ORIGIN,
    authenticatedActorTeamId: scenario.authenticatedActorTeamId,
    targetTeamAId: scenario.targetTeamAId,
    targetTeamBId: scenario.targetTeamBId,
    teamARunId: scenario.teamARunId,
    teamBRunId: scenario.teamBRunId,
    allow,
    deny,
    teamBRequest,
    processStartToken: identity.processStartToken,
  });
}

let sequence = 0;

function nativeNegativeObservation(event: string): Readonly<{
  observedOutcome:
    | 'cross_team_list_rejected'
    | 'cross_team_preview_rejected'
    | 'cross_team_decide_rejected';
  requestFamily: 'approval-page' | 'approval-preview' | 'approval-decision';
}> {
  switch (event) {
    case 'cross_team_list_rejected':
      return Object.freeze({ observedOutcome: event, requestFamily: 'approval-page' });
    case 'cross_team_preview_rejected':
      return Object.freeze({ observedOutcome: event, requestFamily: 'approval-preview' });
    case 'cross_team_decide_rejected':
      return Object.freeze({ observedOutcome: event, requestFamily: 'approval-decision' });
    default:
      throw new Error('p3c_browser_negative_native_event');
  }
}

function observe(
  scenario: BrowserScenario,
  row: MatrixRow,
  event: string,
  target: ApprovalTarget,
  decision: 'allow' | 'deny' | 'none',
  submittedMonotonicNs: bigint,
  observedBrowserStatus?: number,
  observedResponseSha256?: string,
  observedRequestSha256?: string
): void {
  sequence += 1;
  const runId = sha256(`agent-teams.p3c.run/v1\0${scenario.controllerNonce}`);
  const identity = observedSemanticIdentity({
    lane: 'P3.C2.FINAL_NO_FAKE_RUN',
    controllerNonce: scenario.controllerNonce,
    harnessRunId: runId,
    authenticatedActorTeamId: scenario.authenticatedActorTeamId,
    targetTeamRunId: row === '08_cross_team_isolation' ? scenario.teamBRunId : scenario.teamARunId,
    targetTeamId:
      row === '08_cross_team_isolation' ? scenario.targetTeamBId : scenario.targetTeamAId,
    approvalId: target.approvalId,
    generationId: target.generation,
    idempotencyKey: target.idempotencyKey,
    previewRef: target.previewRef,
    decision,
  });
  const record = makeRawRecord({
    controllerNonce: scenario.controllerNonce,
    origin: 'browser',
    row,
    sequence,
    monotonicNs: submittedMonotonicNs.toString(),
    processStartToken: scenario.processStartToken,
    event,
    correlation: sha256(
      `agent-teams.p3c.row-identity/v1\0${scenario.controllerNonce}\0${row}\0${sha256(
        canonicalJson(canonicalRowIdentity(row, identity))
      )}`
    ),
    effectCount: 0,
    payload: makeSemanticPayload({
      origin: 'browser',
      row,
      event,
      identity,
      observedBrowserStatus,
    }),
  });
  writeSync(OBSERVATION_FD, `${canonicalJson(record)}\n`);
  if (row === '08_cross_team_isolation') {
    if (
      observedBrowserStatus === undefined ||
      observedResponseSha256 === undefined ||
      observedRequestSha256 === undefined
    ) {
      throw new Error('p3c_browser_negative_native_observation_missing');
    }
    const negative = nativeNegativeObservation(event);
    browserProducerProvenance.emit('negativeResults', {
      recordType: 'browser-negative-response-observed',
      operationNonce: randomBytes(32).toString('hex'),
      native: Object.freeze({
        actorTeamId: scenario.authenticatedActorTeamId,
        harnessRunId: runId,
        httpStatus: observedBrowserStatus,
        processStartToken: scenario.processStartToken,
        observedOutcome: negative.observedOutcome,
        requestBodySha256: observedRequestSha256,
        requestFamily: negative.requestFamily,
        responseBodySha256: observedResponseSha256,
        targetTeamId: scenario.targetTeamBId,
        targetTeamRunId: productRunIdToProvenanceTeamRunId(scenario.teamBRunId),
      }),
    });
  }
}

async function submit(
  page: Page,
  scenario: BrowserScenario,
  csrf: string,
  target: ApprovalTarget,
  decision: 'allow' | 'deny'
) {
  return page.evaluate(
    async ({ csrfValue, targetValue, decisionValue, teamId, runId }) => {
      const response = await fetch('/api/hosted/v1/team-approvals/decisions', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': csrfValue,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          expectedRunId: runId,
          approvalId: targetValue.approvalId,
          expectedGeneration: targetValue.generation,
          idempotencyKey: targetValue.idempotencyKey,
          decision: decisionValue,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    {
      csrfValue: csrf,
      targetValue: target,
      decisionValue: decision,
      teamId: scenario.targetTeamAId,
      runId: scenario.teamARunId,
    }
  );
}

async function readAllApprovalPages(
  page: Page,
  scenario: BrowserScenario,
  csrf: string
): Promise<readonly Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const approvalIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const cursorKey = cursor === null ? '<initial>' : cursor;
    if (cursors.has(cursorKey)) throw new Error('p3c_browser_approval_cursor_cycle');
    cursors.add(cursorKey);
    const result = await page.evaluate(
      async ({ teamId, runId, csrfValue, pageCursor }) => {
        const request = {
          schemaVersion: 1,
          teamId,
          expectedRunId: runId,
          cursor: pageCursor,
          limit: 32,
        };
        const response = await fetch('/api/hosted/v1/team-approvals/page', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': csrfValue,
          },
          body: JSON.stringify(request),
        });
        return { request, status: response.status, body: (await response.json()) as unknown };
      },
      {
        teamId: scenario.targetTeamAId,
        runId: scenario.teamARunId,
        csrfValue: csrf,
        pageCursor: cursor,
      }
    );
    if (result.request.cursor !== cursor) throw new Error('p3c_browser_approval_cursor_binding');
    if (result.status !== 200) throw new Error('p3c_browser_approval_page_status');
    const parsed = parseHostedTeamApprovalPage(result.body);
    if (!parsed.ok) throw new Error('p3c_browser_approval_page_malformed');
    if (
      parsed.value.teamId !== scenario.targetTeamAId ||
      parsed.value.items.some((item) => item.runId !== scenario.teamARunId)
    )
      throw new Error('p3c_browser_approval_page_authority_binding');
    for (const item of parsed.value.items) {
      if (approvalIds.has(item.approvalId))
        throw new Error('p3c_browser_approval_duplicate_across_pages');
      approvalIds.add(item.approvalId);
      items.push(item as unknown as Record<string, unknown>);
    }
    if (!parsed.value.truncated) return Object.freeze(items);
    if (parsed.value.nextCursor === null) throw new Error('p3c_browser_approval_missing_tail');
    cursor = parsed.value.nextCursor;
  }
}

function exactApprovalItem(
  value: Record<string, unknown>,
  teamId: string,
  runId: string,
  target: ApprovalTarget
): ObservedApprovalItem {
  expect(Reflect.ownKeys(value).sort()).toEqual(
    [
      'approvalId',
      'category',
      'expiresAtMs',
      'generation',
      'previewRef',
      'requestedAtMs',
      'runId',
      'summary',
      'teamId',
    ].sort()
  );
  expect(value).toMatchObject({
    teamId,
    runId,
    approvalId: target.approvalId,
    generation: target.generation,
    category: expect.stringMatching(/^(?:file_change|command|network|other)$/u),
    summary: expect.any(String),
    requestedAtMs: expect.any(Number),
    previewRef: target.previewRef,
  });
  expect(value.expiresAtMs === null || Number.isSafeInteger(value.expiresAtMs)).toBe(true);
  return value as unknown as ObservedApprovalItem;
}

test.use({ storageState: '/sandbox/run/browser-state.json' });
test.describe.configure({ mode: 'serial', retries: 0 });

test('authenticated loopback browser submits actual-owner allow and deny decisions', async ({
  page,
  playwright,
}) => {
  const scenario = readScenario();
  const eventStreamRequests: Array<{ readonly url: string; readonly lastEventId: string | null }> =
    [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/hosted/v1/events') return;
    eventStreamRequests.push({
      url: request.url(),
      lastEventId: request.headers()['last-event-id'] ?? null,
    });
  });
  await page.addInitScript(() => {
    const host = window as unknown as {
      __p3cObservedEventSources: Array<{
        source: EventSource;
        url: string;
        eventIds: string[];
        eventTypes: string[];
      }>;
    };
    host.__p3cObservedEventSources = [];
    const NativeEventSource = globalThis.EventSource;
    globalThis.EventSource = class ObservedEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const observation = {
          source: this as EventSource,
          url: String(url),
          eventIds: [] as string[],
          eventTypes: [] as string[],
        };
        for (const eventType of ['coordination_event', 'resync_required']) {
          this.addEventListener(eventType, (event) => {
            observation.eventTypes.push(event.type);
            observation.eventIds.push((event as MessageEvent).lastEventId);
          });
        }
        host.__p3cObservedEventSources.push(observation);
      }
    };
  });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== PRODUCT_ORIGIN) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.goto(scenario.origin, { waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(PRODUCT_ORIGIN);
  const auth = await page.evaluate(async () => {
    const response = await fetch('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  });
  expect(auth.status).toBe(200);
  expect(auth.body.authenticated).toBe(true);
  expect(auth.body.csrfToken).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{32,512}$/u));
  const csrf = String(auth.body.csrfToken);
  let pending: readonly Record<string, unknown>[] = [];
  await expect
    .poll(
      async () => {
        pending = await readAllApprovalPages(page, scenario, csrf);
        return [scenario.allow, scenario.deny].every((target) =>
          pending.some(({ approvalId }) => approvalId === target.approvalId)
        );
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  const observedItems = [scenario.allow, scenario.deny].map((target) => {
    const item = pending.find(({ approvalId }) => approvalId === target.approvalId);
    expect(item).toBeDefined();
    return exactApprovalItem(item!, scenario.targetTeamAId, scenario.teamARunId, target);
  });
  await expect(page.locator(`[data-approval-id="${scenario.allow.approvalId}"]`)).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.locator(`[data-approval-id="${scenario.deny.approvalId}"]`)).toHaveCount(1, {
    timeout: 15_000,
  });
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __p3cObservedEventSources: Array<{ eventIds: string[] }>;
        }
      ).__p3cObservedEventSources.some(({ eventIds }) => eventIds.some(Boolean)),
    undefined,
    { timeout: 30_000 }
  );
  const firstCursor = await page.evaluate(() => {
    const observations = (
      window as unknown as {
        __p3cObservedEventSources: Array<{
          source: EventSource;
          eventIds: string[];
        }>;
      }
    ).__p3cObservedEventSources;
    const active = observations.find(({ eventIds }) => eventIds.some(Boolean));
    if (!active) throw new Error('p3c_browser_eventsource_event_missing');
    const cursor = active.eventIds.find(Boolean)!;
    active.source.dispatchEvent(new Event('error'));
    return cursor;
  });
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __p3cObservedEventSources: unknown[];
        }
      ).__p3cObservedEventSources.length >= 2,
    undefined,
    { timeout: 30_000 }
  );
  await expect
    .poll(
      () => eventStreamRequests.findLast(({ lastEventId }) => lastEventId !== null)?.lastEventId,
      {
        timeout: 30_000,
      }
    )
    .toBe(firstCursor);
  expect(
    eventStreamRequests.some(
      ({ url, lastEventId }) =>
        url.includes(`after=${encodeURIComponent(firstCursor)}`) && lastEventId === firstCursor
    )
  ).toBe(true);
  await page.waitForFunction(
    () => {
      const observations = (
        window as unknown as {
          __p3cObservedEventSources: Array<{
            eventIds: string[];
            eventTypes: string[];
          }>;
        }
      ).__p3cObservedEventSources;
      const ids = observations.flatMap(({ eventIds }) => eventIds).filter(Boolean);
      return (
        observations.some(({ eventTypes }) => eventTypes.includes('resync_required')) &&
        new Set(ids).size < ids.length
      );
    },
    undefined,
    { timeout: 30_000 }
  );
  await expect(page.locator(`[data-approval-id="${scenario.allow.approvalId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-approval-id="${scenario.deny.approvalId}"]`)).toHaveCount(1);
  const preview = await page.evaluate(
    async ({ teamId, runId, target, csrfValue }) => {
      const response = await fetch('/api/hosted/v1/team-approvals/preview', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': csrfValue,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          expectedRunId: runId,
          approvalId: target.approvalId,
          expectedGeneration: target.generation,
          previewRef: target.previewRef,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    {
      teamId: scenario.targetTeamAId,
      runId: scenario.teamARunId,
      target: observedItems[0],
      csrfValue: csrf,
    }
  );
  expect(preview.status).toBe(200);
  expect(preview.body).toEqual({
    schemaVersion: 1,
    kind: 'approval_preview',
    teamId: scenario.targetTeamAId,
    runId: scenario.teamARunId,
    approvalId: scenario.allow.approvalId,
    generation: scenario.allow.generation,
    content: expect.any(String),
    byteLength: expect.any(Number),
    truncated: expect.any(Boolean),
    isBinary: expect.any(Boolean),
  });
  for (const decision of ['allow', 'deny'] as const) {
    const submittedMonotonicNs = process.hrtime.bigint();
    const result = await submit(page, scenario, csrf, scenario[decision], decision);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: 1,
      outcome: 'committed',
      teamId: scenario.targetTeamAId,
      runId: scenario.teamARunId,
      approvalId: scenario[decision].approvalId,
      generation: scenario[decision].generation,
      decision,
    });
    observe(
      scenario,
      '02_browser_allow_deny',
      `${decision}_submitted`,
      scenario[decision],
      decision,
      submittedMonotonicNs
    );
  }
  const outsider = await playwright.request.newContext({
    baseURL: PRODUCT_ORIGIN,
  });
  try {
    const unauthenticated = await outsider.post('/api/hosted/v1/team-approvals/decisions', {
      maxRedirects: 0,
      headers: { origin: PRODUCT_ORIGIN, 'content-type': 'application/json' },
      data: {
        schemaVersion: 1,
        teamId: scenario.targetTeamAId,
        expectedRunId: scenario.teamARunId,
        approvalId: scenario.allow.approvalId,
        expectedGeneration: scenario.allow.generation,
        idempotencyKey: scenario.allow.idempotencyKey,
        decision: 'allow',
      },
    });
    expect([401, 403]).toContain(unauthenticated.status());
    const unauthenticatedPreview = await outsider.post('/api/hosted/v1/team-approvals/preview', {
      maxRedirects: 0,
      headers: { origin: PRODUCT_ORIGIN, 'content-type': 'application/json' },
      data: {
        schemaVersion: 1,
        teamId: scenario.targetTeamAId,
        expectedRunId: scenario.teamARunId,
        approvalId: scenario.allow.approvalId,
        expectedGeneration: scenario.allow.generation,
        previewRef: scenario.allow.previewRef,
      },
    });
    expect([401, 403]).toContain(unauthenticatedPreview.status());
  } finally {
    await outsider.dispose();
  }
  const missingCsrf = await page.evaluate(
    async ({ teamId, runId, target }) => {
      const response = await fetch('/api/hosted/v1/team-approvals/decisions', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          expectedRunId: runId,
          approvalId: target.approvalId,
          expectedGeneration: target.generation,
          idempotencyKey: target.idempotencyKey,
          decision: 'allow',
        }),
      });
      return response.status;
    },
    {
      teamId: scenario.targetTeamAId,
      runId: scenario.teamARunId,
      target: scenario.allow,
    }
  );
  expect(missingCsrf).toBe(403);
  const crossTeamResponses = await page.evaluate(
    async ({ teamId, runId, target, csrfValue }) => {
      const common = {
        method: 'POST',
        credentials: 'include' as const,
        cache: 'no-store' as const,
        redirect: 'error' as const,
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': csrfValue,
        },
      };
      const requests = [
        [
          '/api/hosted/v1/team-approvals/page',
          {
            schemaVersion: 1,
            teamId,
            expectedRunId: runId,
            cursor: null,
            limit: 32,
          },
        ],
        [
          '/api/hosted/v1/team-approvals/preview',
          {
            schemaVersion: 1,
            teamId,
            expectedRunId: runId,
            approvalId: target.approvalId,
            expectedGeneration: target.generation,
            previewRef: target.previewRef,
          },
        ],
        [
          '/api/hosted/v1/team-approvals/decisions',
          {
            schemaVersion: 1,
            teamId,
            expectedRunId: runId,
            approvalId: target.approvalId,
            expectedGeneration: target.generation,
            idempotencyKey: target.idempotencyKey,
            decision: 'deny',
          },
        ],
      ] as const;
      return Promise.all(
        requests.map(async ([path, body]) => {
          const requestBody = JSON.stringify(body);
          const response = await fetch(path, { ...common, body: requestBody });
          return { status: response.status, body: await response.text(), requestBody };
        })
      );
    },
    {
      teamId: scenario.targetTeamBId,
      runId: scenario.teamBRunId,
      target: scenario.teamBRequest,
      csrfValue: csrf,
    }
  );
  expect(crossTeamResponses).toHaveLength(3);
  for (const response of crossTeamResponses) expect([403, 404]).toContain(response.status);
  const crossTeamEvents = [
    ['cross_team_list_rejected', 'none'],
    ['cross_team_preview_rejected', 'none'],
    ['cross_team_decide_rejected', 'deny'],
  ] as const;
  crossTeamEvents.forEach(([event, decision], index) => {
    observe(
      scenario,
      '08_cross_team_isolation',
      event,
      scenario.teamBRequest,
      decision,
      process.hrtime.bigint(),
      crossTeamResponses[index]?.status,
      sha256(crossTeamResponses[index]?.body ?? ''),
      sha256(crossTeamResponses[index]?.requestBody ?? '')
    );
  });
});
