import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_SCHEMA_VERSION,
  type HostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import { HostedReadinessBanner } from '@features/hosted-readiness/renderer';
import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedOperatorSurfaces } from '../../../src/renderer/hosted/HostedOperatorSurfaces';

import type {
  HostedTeamApprovalRendererSlice,
  HostedTeamApprovalRendererState,
} from '@features/team-approvals/renderer';

const DEPLOYMENT_ID = parseDeploymentId('deployment_banner');
const BOOT_ID = parseBootId('boot_banner');

function projection(state: 'ready' | 'degraded' | 'not_offered'): HostedReadinessProjection {
  const offered = state !== 'not_offered';
  const degraded = state === 'degraded';
  return {
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    revision: 1,
    requiredReadiness: offered ? ['serve', 'auth'] : [],
    dimensions: HOSTED_READINESS_DIMENSIONS.map((dimension) => ({
      dimension,
      status: degraded && dimension === 'auth' ? 'not_ready' : 'ready',
      reasons: degraded && dimension === 'auth' ? (['authentication_unavailable'] as const) : [],
    })),
    terminal: { dimension: 'terminal', status: 'not_offered', reasons: [] },
    facets: [
      {
        facetId: 'team.read',
        availability: offered
          ? degraded
            ? 'temporarily_unavailable'
            : 'available'
          : 'not_offered',
        requiredReadiness: offered ? ['read'] : [],
        reasons: offered ? (degraded ? ['temporarily_unavailable'] : []) : ['not_offered'],
      },
    ],
    actions: [
      {
        actionId: 'team.read.list',
        facetId: 'team.read',
        implementation: offered ? 'implemented' : 'not_implemented',
        availability: offered
          ? degraded
            ? 'temporarily_unavailable'
            : 'available'
          : 'not_offered',
        requiredReadiness: offered ? ['read'] : [],
        reasons: offered ? (degraded ? ['temporarily_unavailable'] : []) : ['not_implemented'],
      },
    ],
  };
}

async function renderBanner(value: HostedReadinessProjection): Promise<{
  readonly host: HTMLDivElement;
  readonly root: Root;
}> {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedReadinessBanner projection={value} />);
  });
  return { host, root };
}

describe('HostedReadinessBanner', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['ready', 'Hosted features are ready'],
    ['degraded', 'Hosted features are degraded'],
    ['not_offered', 'Hosted features are not offered'],
  ] as const)('renders the accessible %s state', async (state, heading) => {
    const { host, root } = await renderBanner(projection(state));
    const banner = host.querySelector('[role="status"]');

    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.getAttribute('aria-atomic')).toBe('true');
    expect(banner?.getAttribute('aria-label')).toBe(heading);
    expect(banner?.getAttribute('data-hosted-readiness-state')).toBe(state);
    expect(host.textContent).toContain(heading);
    act(() => root.unmount());
  });

  it('describes temporary denial without calling the action unimplemented', async () => {
    const value = projection('degraded');
    expect(value.actions[0]?.implementation).toBe('implemented');
    const { host, root } = await renderBanner(value);

    expect(host.textContent).toContain('temporarily unavailable');
    expect(host.textContent).not.toContain('not implemented');
    act(() => root.unmount());
  });

  it('keeps operator reads mounted when only mutation readiness is unavailable', async () => {
    const value: HostedReadinessProjection = {
      ...projection('ready'),
      dimensions: projection('ready').dimensions.map((dimension) =>
        dimension.dimension === 'mutation'
          ? { ...dimension, status: 'not_ready', reasons: ['mutation_unavailable'] }
          : dimension
      ),
    };
    const snapshot: HostedTeamApprovalRendererState = Object.freeze({
      mounted: true,
      items: Object.freeze([]),
      nextCursor: null,
      pageStatus: 'ready',
      pageError: null,
      selectedApprovalId: null,
      preview: null,
      previewStatus: 'idle',
      previewError: null,
      pendingDecision: null,
      decisionReceipt: null,
      decisionError: null,
      focusRequest: null,
    });
    const noOp = async (): Promise<void> => undefined;
    const approvalSlice: HostedTeamApprovalRendererSlice = Object.freeze({
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      mount: () => () => undefined,
      reload: noOp,
      loadMore: noOp,
      selectApproval: noOp,
      allow: noOp,
      deny: noOp,
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<HostedOperatorSurfaces readiness={value} approvalSlice={approvalSlice} />);
    });

    expect(host.textContent).toContain('Pending approvals');
    expect(host.textContent).toContain('There are no pending approvals');
    expect(host.textContent).not.toContain('Hosted operator reads are temporarily unavailable');
    act(() => root.unmount());
  });
});
