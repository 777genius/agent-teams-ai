import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  useOpenCodeProviderScopedModelAuthority,
  usePublishOpenCodeProviderScopedStatus,
} from '@renderer/components/team/dialogs/useOpenCodeProviderScopedModelAuthority';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

interface HarnessProps {
  projectPath: string;
  sourceProviderId: string | null;
  providerStatus: CliProviderStatus | null;
  preservePreviousStatus?: boolean;
  onStatusChange: (statuses: ReadonlyMap<string, CliProviderStatus>) => void;
}

function freshScopedStatus(model: string, statusMessage?: string): CliProviderStatus {
  return {
    providerId: 'opencode',
    statusCheckOutcome: 'model_only',
    statusMessage,
    models: [model],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      staleAt: '2099-01-01T00:00:00.000Z',
      models: [{ id: model, launchModel: model, displayName: model }],
    },
  } as CliProviderStatus;
}

function Harness({
  projectPath,
  sourceProviderId,
  providerStatus,
  preservePreviousStatus,
  onStatusChange,
}: HarnessProps) {
  const [statuses, publishStatus] = useOpenCodeProviderScopedModelAuthority(projectPath);
  usePublishOpenCodeProviderScopedStatus(
    publishStatus,
    sourceProviderId,
    providerStatus,
    preservePreviousStatus
  );
  useEffect(() => {
    onStatusChange(statuses);
  }, [onStatusChange, statuses]);
  return null;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useOpenCodeProviderScopedModelAuthority', () => {
  it('clears project A authority while project B has no fresh result', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const status = freshScopedStatus('openrouter/model-a');
    const snapshots: ReadonlyMap<string, CliProviderStatus>[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (
      projectPath: string,
      sourceProviderId: string | null,
      providerStatus: CliProviderStatus | null,
      preservePreviousStatus = false
    ) => {
      await act(async () => {
        root.render(
          <Harness
            projectPath={projectPath}
            sourceProviderId={sourceProviderId}
            providerStatus={providerStatus}
            preservePreviousStatus={preservePreviousStatus}
            onStatusChange={(value) => snapshots.push(value)}
          />
        );
        await Promise.resolve();
      });
    };

    await render('/tmp/project-a', ' OpenRouter ', status);
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await render('/tmp/project-a', 'openrouter', null);
    expect(snapshots.at(-1)?.has('openrouter')).toBe(false);

    await render('/tmp/project-a', 'openrouter', status);
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await render('/tmp/project-b', 'openrouter', null, true);
    expect(snapshots.at(-1)?.has('openrouter')).toBe(false);

    await render('/tmp/project-b', 'openrouter', status);
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await act(async () => root.unmount());
  });

  it('retains sole fresh authority when its publisher detaches on collapse', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const status = freshScopedStatus('openrouter/sole', 'sole');
    const snapshots: ReadonlyMap<string, CliProviderStatus>[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Publisher({
      listener,
    }: {
      listener: ReturnType<typeof useOpenCodeProviderScopedModelAuthority>[1];
    }) {
      usePublishOpenCodeProviderScopedStatus(listener, 'openrouter', status);
      return null;
    }
    function CollapsiblePublisher({ expanded }: { expanded: boolean }) {
      const [statuses, publishStatus] = useOpenCodeProviderScopedModelAuthority('/tmp/project');
      useEffect(() => {
        snapshots.push(statuses);
      }, [statuses]);
      return expanded ? <Publisher listener={publishStatus} /> : null;
    }

    await act(async () => {
      root.render(<CollapsiblePublisher expanded />);
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await act(async () => {
      root.render(<CollapsiblePublisher expanded={false} />);
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await act(async () => root.unmount());
  });

  it('keeps another live publisher authoritative when one same-source publisher detaches', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const firstStatus = freshScopedStatus('openrouter/first', 'first');
    const secondStatus = freshScopedStatus('openrouter/second', 'second');
    const snapshots: ReadonlyMap<string, CliProviderStatus>[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Publisher({
      listener,
      status,
    }: {
      listener: ReturnType<typeof useOpenCodeProviderScopedModelAuthority>[1];
      status: CliProviderStatus;
    }) {
      usePublishOpenCodeProviderScopedStatus(listener, 'openrouter', status);
      return null;
    }
    function MultiplePublishers({ showSecond }: { showSecond: boolean }) {
      const [statuses, publishStatus] = useOpenCodeProviderScopedModelAuthority('/tmp/project');
      useEffect(() => {
        snapshots.push(statuses);
      }, [statuses]);
      return (
        <>
          <Publisher listener={publishStatus} status={firstStatus} />
          {showSecond ? <Publisher listener={publishStatus} status={secondStatus} /> : null}
        </>
      );
    }

    await act(async () => {
      root.render(<MultiplePublishers showSecond />);
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.get('openrouter')).toBe(secondStatus);

    await act(async () => {
      root.render(<MultiplePublishers showSecond={false} />);
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.get('openrouter')).toBe(firstStatus);

    await act(async () => root.unmount());
  });

  it('preserves fresh same-scope authority during refresh and replaces it on a definitive result', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const status = freshScopedStatus('openrouter/provider-model-b', 'fresh');
    const replacement = freshScopedStatus('openrouter/replacement', 'replacement');
    const snapshots: ReadonlyMap<string, CliProviderStatus>[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (providerStatus: CliProviderStatus | null, refreshing: boolean) => {
      await act(async () => {
        root.render(
          <Harness
            projectPath="/tmp/project"
            sourceProviderId="openrouter"
            providerStatus={providerStatus}
            preservePreviousStatus={refreshing}
            onStatusChange={(value) => snapshots.push(value)}
          />
        );
        await Promise.resolve();
      });
    };

    await render(status, false);
    await render(null, true);
    expect(snapshots.at(-1)?.get('openrouter')).toBe(status);

    await render(replacement, false);
    expect(snapshots.at(-1)?.get('openrouter')).toBe(replacement);

    await render(null, false);
    expect(snapshots.at(-1)?.has('openrouter')).toBe(false);

    await act(async () => root.unmount());
  });
});
