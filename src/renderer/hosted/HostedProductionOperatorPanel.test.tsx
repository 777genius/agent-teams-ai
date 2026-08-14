import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
} from '@features/team-approvals/contracts';
import { HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import {
  parseBootId,
  parseDeploymentId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedReadinessProjection } from '@features/hosted-readiness/contracts';
import type {
  HostedTeamApprovalRendererSlice,
  HostedTeamApprovalRendererSliceDependencies,
} from '@features/team-approvals/renderer';

const testState = vi.hoisted(() => ({
  approvalSlices: [] as HostedTeamApprovalRendererSlice[],
  controlState: vi.fn(),
  readinessLoad: vi.fn(),
}));

vi.mock('@features/hosted-readiness/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/hosted-readiness/renderer')>();
  return {
    ...actual,
    createHostedReadinessTransport: vi.fn(() => ({ load: testState.readinessLoad })),
  };
});

vi.mock('@features/team-lifecycle/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/team-lifecycle/renderer')>();
  return {
    ...actual,
    createHostedTeamLifecycleTransport: vi.fn(() => ({
      getControlState: testState.controlState,
    })),
  };
});

vi.mock('@features/team-approvals/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/team-approvals/renderer')>();
  return {
    ...actual,
    createHostedTeamApprovalRendererSlice: vi.fn(
      (dependencies: HostedTeamApprovalRendererSliceDependencies) => {
        const slice = actual.createHostedTeamApprovalRendererSlice(dependencies);
        testState.approvalSlices.push(slice);
        return slice;
      }
    ),
  };
});

import { HostedProductionOperatorPanel } from './HostedProductionOperatorPanel';

const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const RUN_A = parseRunId(`run_${'3'.repeat(32)}`);
const RUN_B = parseRunId(`run_${'4'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId('deployment_test');
const BOOT_ID = parseBootId('boot_test');
const CSRF_TOKEN = 'csrf_token_abcdefghijklmnopqrstuvwxyz123456';
const APPROVAL_A = `approval_${'a'.repeat(32)}`;
const APPROVAL_B = `approval_${'b'.repeat(32)}`;

const READY: HostedReadinessProjection = Object.freeze({
  schemaVersion: 1,
  kind: 'success',
  deploymentId: DEPLOYMENT_ID,
  bootId: BOOT_ID,
  revision: 1,
  requiredReadiness: Object.freeze(['serve', 'auth', 'read', 'mutation'] as const),
  dimensions: Object.freeze(
    ['serve', 'auth', 'read', 'mutation'].map((dimension) =>
      Object.freeze({
        dimension: dimension as 'serve' | 'auth' | 'read' | 'mutation',
        status: 'ready' as const,
        reasons: Object.freeze([]),
      })
    )
  ),
  terminal: Object.freeze({
    dimension: 'terminal',
    status: 'not_offered',
    reasons: Object.freeze([] as const),
  }),
  facets: Object.freeze([
    Object.freeze({
      facetId: 'team-approvals',
      availability: 'available',
      requiredReadiness: Object.freeze(['serve', 'auth', 'read', 'mutation'] as const),
      reasons: Object.freeze([]),
    }),
  ]),
  actions: Object.freeze([]),
});

function controlState(runId: typeof RUN_A | typeof RUN_B) {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'control_state' as const,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    runId,
    resourceRevision: 1,
    availableActions: Object.freeze([]),
  });
}

function approvalItem(approvalId: string, summary: string, runId = RUN_A) {
  return Object.freeze({
    teamId: TEAM_ID,
    runId,
    approvalId,
    generation: 'generation_1',
    category: 'command',
    summary,
    requestedAtMs: 1,
    expiresAtMs: null,
    previewRef: null,
  });
}

function approvalPage(items: readonly ReturnType<typeof approvalItem>[]) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'approval_page',
    teamId: TEAM_ID,
    items,
    nextCursor: null,
    truncated: false,
    budget: Object.freeze({
      itemLimit: 25,
      byteLimit: 65_536,
      timeLimitMs: 100,
      usedItems: items.length,
      usedBytes: 100,
      elapsedMs: 1,
    }),
  });
}

function response(
  status: number,
  value: unknown
): Readonly<{ status: number; json(): Promise<unknown> }> {
  return Object.freeze({ status, json: async () => value });
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await act(flushReact);
  }
  expect(predicate()).toBe(true);
}

function renderPanel(getCsrfToken: () => string | null): {
  readonly host: HTMLDivElement;
  readonly root: Root;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <HostedProductionOperatorPanel
        teamId={TEAM_ID}
        workspaceId={WORKSPACE_ID}
        runtimeIdentity={{ deploymentId: DEPLOYMENT_ID, bootId: BOOT_ID }}
        getCsrfToken={getCsrfToken}
      />
    );
  });
  return { host, root };
}

describe('HostedProductionOperatorPanel approval wiring', () => {
  const roots: Root[] = [];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    testState.approvalSlices.length = 0;
    testState.controlState.mockReset().mockResolvedValue(controlState(RUN_A));
    testState.readinessLoad.mockReset().mockResolvedValue(READY);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
      await flushReact();
    });
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for readiness and sends authenticated CSRF-aware approval reads', async () => {
    let resolveReadiness!: (projection: HostedReadinessProjection) => void;
    testState.readinessLoad.mockReturnValue(
      new Promise<HostedReadinessProjection>((resolve) => {
        resolveReadiness = resolve;
      })
    );
    let csrfToken: string | null = null;
    const fetchMock = vi.fn(async (_route: string, _init?: unknown) =>
      response(200, approvalPage([]))
    );
    vi.stubGlobal('fetch', fetchMock);

    const rendered = renderPanel(() => csrfToken);
    roots.push(rendered.root);
    await waitFor(() => testState.approvalSlices.length === 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveReadiness(READY);
      await flushReact();
    });
    await waitFor(
      () => rendered.host.textContent?.includes('Approvals are temporarily unavailable') === true
    );
    expect(fetchMock).not.toHaveBeenCalled();

    csrfToken = CSRF_TOKEN;
    const refresh = rendered.host.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh approvals"]'
    );
    expect(refresh).not.toBeNull();
    await act(async () => {
      refresh?.click();
      await flushReact();
    });
    await waitFor(() => fetchMock.mock.calls.length === 1);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(HOSTED_TEAM_APPROVAL_PAGE_ROUTE);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: expect.objectContaining({ 'x-agent-teams-csrf': CSRF_TOKEN }),
    });
  });

  it('submits one Allow and one Deny with distinct cryptographic idempotency keys', async () => {
    let pending = [
      approvalItem(APPROVAL_A, 'First request'),
      approvalItem(APPROVAL_B, 'Second request'),
    ];
    const decisions: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (route: string, init: { body?: string }) => {
      if (route === HOSTED_TEAM_APPROVAL_PAGE_ROUTE) return response(200, approvalPage(pending));
      if (route === HOSTED_TEAM_APPROVAL_DECISION_ROUTE) {
        const command = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        decisions.push(command);
        pending = pending.filter((item) => item.approvalId !== command.approvalId);
        return response(200, {
          schemaVersion: 1,
          outcome: 'committed',
          teamId: TEAM_ID,
          runId: command.expectedRunId,
          approvalId: command.approvalId,
          generation: command.expectedGeneration,
          decision: command.decision,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const rendered = renderPanel(() => CSRF_TOKEN);
    roots.push(rendered.root);
    await waitFor(() => rendered.host.querySelector(`[data-approval-id="${APPROVAL_A}"]`) !== null);

    await act(async () => {
      rendered.host.querySelector<HTMLButtonElement>(`[data-approval-id="${APPROVAL_A}"]`)?.click();
      await flushReact();
    });
    await waitFor(
      () => rendered.host.querySelector('[aria-label="Allow: First request"]') !== null
    );
    const allow = rendered.host.querySelector<HTMLButtonElement>(
      '[aria-label="Allow: First request"]'
    );
    await act(async () => {
      allow?.click();
      allow?.click();
      await flushReact();
    });
    await waitFor(() => decisions.length === 1);
    await waitFor(() => rendered.host.querySelector(`[data-approval-id="${APPROVAL_B}"]`) !== null);

    await act(async () => {
      rendered.host.querySelector<HTMLButtonElement>(`[data-approval-id="${APPROVAL_B}"]`)?.click();
      await flushReact();
    });
    await waitFor(
      () => rendered.host.querySelector('[aria-label="Deny: Second request"]') !== null
    );

    const deny = rendered.host.querySelector<HTMLButtonElement>(
      '[aria-label="Deny: Second request"]'
    );
    await act(async () => {
      deny?.click();
      deny?.click();
      await flushReact();
    });
    await waitFor(() => decisions.length === 2);

    expect(decisions.map(({ decision }) => decision)).toEqual(['allow', 'deny']);
    const keys = decisions.map(({ idempotencyKey }) => idempotencyKey);
    expect(keys[0]).toMatch(/^browser:[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^browser:[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(2);
    const decisionCalls = fetchMock.mock.calls.filter(
      ([route]) => route === HOSTED_TEAM_APPROVAL_DECISION_ROUTE
    );
    expect(decisionCalls).toHaveLength(2);
    for (const [, init] of decisionCalls) {
      expect(init).toMatchObject({
        credentials: 'include',
        headers: expect.objectContaining({ 'x-agent-teams-csrf': CSRF_TOKEN }),
      });
    }
  });

  it('fails closed without sending a decision when crypto.randomUUID is unavailable', async () => {
    const fetchMock = vi.fn(async (route: string) => {
      if (route === HOSTED_TEAM_APPROVAL_PAGE_ROUTE) {
        return response(200, approvalPage([approvalItem(APPROVAL_A, 'Secure request')]));
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', Object.freeze({}));

    const rendered = renderPanel(() => CSRF_TOKEN);
    roots.push(rendered.root);
    await waitFor(() => rendered.host.querySelector(`[data-approval-id="${APPROVAL_A}"]`) !== null);

    await act(async () => {
      rendered.host.querySelector<HTMLButtonElement>(`[data-approval-id="${APPROVAL_A}"]`)?.click();
      await flushReact();
    });
    await waitFor(
      () => rendered.host.querySelector('[aria-label="Allow: Secure request"]') !== null
    );

    await act(async () => {
      rendered.host.querySelector<HTMLButtonElement>('[aria-label="Allow: Secure request"]')?.click();
      await flushReact();
    });

    expect(rendered.host.textContent).toContain('A secure approval command could not be created.');
    expect(
      fetchMock.mock.calls.filter(([route]) => route === HOSTED_TEAM_APPROVAL_DECISION_ROUTE)
    ).toHaveLength(0);
  });

  it('memoizes by team/run, bounds control polling, and cleans up across rotation and remount', async () => {
    vi.useFakeTimers();
    let resolveSecondPoll!: (value: unknown) => void;
    testState.controlState
      .mockResolvedValueOnce(controlState(RUN_A))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondPoll = resolve;
        })
      )
      .mockResolvedValue(controlState(RUN_B));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, approvalPage([])))
    );

    const rendered = renderPanel(() => CSRF_TOKEN);
    roots.push(rendered.root);
    await waitFor(() => testState.approvalSlices.length === 1);
    const firstSlice = testState.approvalSlices[0]!;
    expect(firstSlice.getSnapshot().mounted).toBe(true);

    await act(async () => {
      rendered.root.render(
        <HostedProductionOperatorPanel
          teamId={TEAM_ID}
          workspaceId={WORKSPACE_ID}
          runtimeIdentity={{ deploymentId: DEPLOYMENT_ID, bootId: BOOT_ID }}
          getCsrfToken={() => CSRF_TOKEN}
        />
      );
      await flushReact();
    });
    expect(testState.approvalSlices).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushReact();
    });
    expect(testState.controlState).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecondPoll({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        kind: 'unavailable',
        retryAfterMs: null,
      });
      await flushReact();
    });
    expect(testState.approvalSlices).toHaveLength(1);
    expect(firstSlice.getSnapshot().mounted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushReact();
    });
    await waitFor(() => testState.approvalSlices.length === 2);
    expect(firstSlice.getSnapshot().mounted).toBe(false);
    expect(testState.approvalSlices[1]?.getSnapshot().mounted).toBe(true);

    await act(async () => {
      rendered.root.unmount();
      await flushReact();
    });
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(testState.approvalSlices[1]?.getSnapshot().mounted).toBe(false);

    testState.controlState.mockResolvedValue(controlState(RUN_B));
    const remounted = renderPanel(() => CSRF_TOKEN);
    roots.push(remounted.root);
    await waitFor(() => testState.approvalSlices.length === 3);
    expect(testState.approvalSlices[2]?.getSnapshot().mounted).toBe(true);
  });
});
