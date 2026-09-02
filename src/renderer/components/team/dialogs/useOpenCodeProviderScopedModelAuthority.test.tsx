import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeProviderScopedStatusListener,
  useOpenCodeProviderScopedModelAuthority,
  usePublishOpenCodeProviderScopedStatus,
} from './useOpenCodeProviderScopedModelAuthority';

import type { CliProviderStatus } from '@shared/types';

const START = new Date('2026-09-02T00:00:00.000Z').getTime();
let statuses: ReadonlyMap<string, CliProviderStatus> = new Map();

type CatalogState = 'fresh' | 'loading' | 'stale' | 'error';
interface PublisherProps {
  id: string;
  status: CliProviderStatus;
  catalogState?: CatalogState;
  statusListener?: OpenCodeProviderScopedStatusListener;
}

function buildStatus(model: string, lifetimeMs: number): CliProviderStatus {
  return {
    providerId: 'opencode',
    authenticated: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    modelCatalogRefreshState: 'ready',
    models: [model],
    capabilities: { teamLaunch: true },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1).toISOString(),
      staleAt: new Date(Date.now() + lifetimeMs).toISOString(),
      models: [{ id: model, launchModel: model, displayName: model }],
    },
  } as unknown as CliProviderStatus;
}

const Publisher = ({
  id,
  status,
  catalogState = 'fresh',
  statusListener,
}: PublisherProps): React.JSX.Element | null => {
  usePublishOpenCodeProviderScopedStatus(
    statusListener,
    id,
    catalogState === 'fresh' ? status : null,
    catalogState === 'loading'
  );
  return null;
};

const Harness = ({
  projectPath,
  publishers,
}: {
  projectPath: string;
  publishers: PublisherProps[];
}) => {
  const [capturedStatuses, capturedListener] = useOpenCodeProviderScopedModelAuthority(projectPath);
  useEffect(() => {
    statuses = capturedStatuses;
  }, [capturedStatuses]);
  return publishers.map((publisher) => (
    <Publisher
      key={publisher.id + publisher.status.models[0]}
      {...publisher}
      statusListener={capturedListener}
    />
  ));
};

async function renderHarness(projectPath: string, publishers: PublisherProps[]) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = async (nextPath: string, nextPublishers: PublisherProps[]) => {
    await act(async () =>
      root.render(<Harness projectPath={nextPath} publishers={nextPublishers} />)
    );
  };
  await render(projectPath, publishers);
  return {
    render,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  statuses = new Map();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useOpenCodeProviderScopedModelAuthority', () => {
  it('expires retained authority after its publisher collapses and unmounts', async () => {
    const status = buildStatus('model-a', 1_000);
    const view = await renderHarness('/project', [{ id: 'source', status }]);

    await view.render('/project', []);
    expect(statuses.get('source')).toBe(status);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(statuses.has('source')).toBe(false);
    await view.unmount();
  });

  it('reveals another fresh publisher when the latest publisher expires', async () => {
    const stillFresh = buildStatus('model-a', 5_000);
    const expiresFirst = buildStatus('model-b', 1_000);
    const view = await renderHarness('/project', [
      { id: 'source', status: stillFresh },
      { id: 'source', status: expiresFirst },
    ]);

    expect(statuses.get('source')).toBe(expiresFirst);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(statuses.get('source')).toBe(stillFresh);
    await view.unmount();
  });

  it('explicitly withdraws a publisher contribution when its catalog becomes stale', async () => {
    const status = buildStatus('model-a', 5_000);
    const view = await renderHarness('/project', [{ id: 'source', status }]);

    await view.render('/project', [{ id: 'source', status, catalogState: 'stale' }]);
    expect(statuses.has('source')).toBe(false);
    await view.unmount();
  });

  it('preserves authority only while loading and withdraws it on error', async () => {
    const status = buildStatus('model-a', 5_000);
    const view = await renderHarness('/project', [{ id: 'source', status }]);

    await view.render('/project', [{ id: 'source', status, catalogState: 'loading' }]);
    expect(statuses.get('source')).toBe(status);
    await view.render('/project', [{ id: 'source', status, catalogState: 'error' }]);
    expect(statuses.has('source')).toBe(false);
    await view.unmount();
  });

  it('withdraws retained authority when a fresh publish is not authoritative', async () => {
    const status = buildStatus('model-a', 5_000);
    const rejected = {
      ...status,
      modelCatalog: { ...status.modelCatalog!, models: [] },
    };
    const view = await renderHarness('/project', [{ id: 'source', status }]);

    await view.render('/project', [{ id: 'source', status: rejected }]);
    expect(statuses.has('source')).toBe(false);
    await view.unmount();
  });

  it('discards old scope authority and its expiry timer on project change', async () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const oldStatus = buildStatus('old-model', 1_000);
    const newStatus = buildStatus('new-model', 5_000);
    const view = await renderHarness('/old', [{ id: 'source', status: oldStatus }]);

    await view.render('/new', [{ id: 'source', status: newStatus }]);
    expect(statuses.get('source')).toBe(newStatus);
    expect(clearTimeout).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(statuses.get('source')).toBe(newStatus);
    await view.unmount();
  });
});
