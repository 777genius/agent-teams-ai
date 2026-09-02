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
  onStatusChange: (statuses: ReadonlyMap<string, CliProviderStatus>) => void;
}

function Harness({ projectPath, sourceProviderId, providerStatus, onStatusChange }: HarnessProps) {
  const [statuses, publishStatus] = useOpenCodeProviderScopedModelAuthority(projectPath);
  usePublishOpenCodeProviderScopedStatus(publishStatus, sourceProviderId, providerStatus);
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
  it('publishes fresh authority, withdraws it, and resets it across project scopes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const status = {
      providerId: 'opencode',
      statusCheckOutcome: 'model_only',
    } as CliProviderStatus;
    const snapshots: ReadonlyMap<string, CliProviderStatus>[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (
      projectPath: string,
      sourceProviderId: string | null,
      providerStatus: CliProviderStatus | null
    ) => {
      await act(async () => {
        root.render(
          <Harness
            projectPath={projectPath}
            sourceProviderId={sourceProviderId}
            providerStatus={providerStatus}
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
    await render('/tmp/project-b', 'openrouter', status);
    expect(snapshots.at(-1)?.size).toBe(0);

    await act(async () => root.unmount());
  });
});
