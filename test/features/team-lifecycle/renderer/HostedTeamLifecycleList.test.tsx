import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
import { HostedTeamLifecycleList } from '@features/team-lifecycle/renderer';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const REVISION = parseRevision('revision_hosted-ui');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);

function success(name: string, fill = 'b'): CanonicalListTeamLifecycleResult {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION,
    items: [
      {
        workspaceId: WORKSPACE_ID,
        teamId: parseTeamId(`team_${fill.repeat(32)}`),
        displayName: name,
        lifecycle: 'running',
        revision: REVISION,
      },
    ],
    nextCursor: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renderList(
  transport: TeamLifecycleReadTransportApi
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedTeamLifecycleList transport={transport} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

describe('HostedTeamLifecycleList', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders typed failure instead of empty and retries to a successful list', async () => {
    const failure: CanonicalListTeamLifecycleResult = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: { code: 'unavailable', reason: 'identity_unavailable' },
      retryable: true,
    };
    const transport = {
      listTeamLifecycle: vi
        .fn()
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce(success('Recovered Team')),
    };
    const { host, root } = await renderList(transport);

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain('list.loadFailed');
    expect(host.textContent).not.toContain('list.empty.title');
    const retry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'list.actions.retry'
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Recovered Team');
    expect(host.textContent).toContain('list.status.running');
    expect(host.querySelector('ul[aria-label="list.title"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="actions.refresh"]')).not.toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('keeps the latest retry when an older request completes last', async () => {
    const first = deferred<CanonicalListTeamLifecycleResult>();
    const transport = {
      listTeamLifecycle: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(success('Latest Team', 'c')),
    };
    const { host, root } = await renderList(transport);
    const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="actions.refresh"]');

    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Latest Team');

    await act(async () => {
      first.resolve(success('Stale Team', 'd'));
      await first.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Latest Team');
    expect(host.textContent).not.toContain('Stale Team');
    act(() => root.unmount());
  });
});
