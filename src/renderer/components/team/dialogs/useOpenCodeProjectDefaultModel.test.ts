import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenCodeProjectDefaultModel } from './useOpenCodeDefaultRouteLabel';

import type { OpenCodeProjectDefaultModel } from './openCodeDefaultModel';
import type { CliProviderStatus } from '@shared/types';

const ROUTE = 'opencode/big-pickle';

// Store shape of both the provisional first snapshot and a background refresh.
function status(refreshing: boolean): CliProviderStatus {
  return {
    providerId: 'opencode',
    models: [ROUTE],
    statusCheckOutcome: refreshing ? 'pending' : 'authoritative',
    statusCheckErrorCode: refreshing ? 'partial_response' : undefined,
    modelCatalogRefreshState: refreshing ? 'loading' : 'ready',
    modelCatalog: {
      providerId: 'opencode',
      status: 'ready',
      defaultModelId: ROUTE,
      defaultLaunchModel: ROUTE,
      models: [{ id: ROUTE, launchModel: ROUTE, displayName: 'big-pickle' }],
    },
  } as unknown as CliProviderStatus;
}

describe('useOpenCodeProjectDefaultModel', () => {
  const Probe = (props: { status: CliProviderStatus; projectPath: string }): React.ReactElement =>
    React.createElement(
      'output',
      null,
      JSON.stringify(useOpenCodeProjectDefaultModel(props.status, props.projectPath))
    );

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('waits on a first load, then keeps the settled default through a background refresh', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const render = (
      refreshing: boolean,
      projectPath = '/workspace/a'
    ): OpenCodeProjectDefaultModel => {
      act(() =>
        root.render(React.createElement(Probe, { status: status(refreshing), projectPath }))
      );
      return JSON.parse(host.textContent ?? 'null') as OpenCodeProjectDefaultModel;
    };

    expect(render(true)).toEqual({ state: 'unknown' });
    expect(render(false)).toEqual({ state: 'available', model: ROUTE });
    expect(render(true)).toEqual({ state: 'available', model: ROUTE });
    expect(render(true, '/workspace/b')).toEqual({ state: 'unknown' });

    act(() => root.unmount());
  });
});
