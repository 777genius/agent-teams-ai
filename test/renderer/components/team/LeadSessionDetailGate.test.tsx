import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSessionDetail = vi.fn(async () => undefined);
const storeState = {
  fetchSessionDetail,
  tabSessionData: {} as Record<
    string,
    {
      sessionDetail?: { session?: { id?: string } | null } | null;
      sessionDetailLoading?: boolean;
    }
  >,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

import { LeadSessionDetailGate } from '@renderer/components/team/LeadSessionDetailGate';

describe('LeadSessionDetailGate', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    fetchSessionDetail.mockClear();
    storeState.tabSessionData = {};
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not fetch while disabled', async () => {
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled={false}
        />
      );
    });

    expect(fetchSessionDetail).not.toHaveBeenCalled();
  });

  it('fetches once when enabled and unloaded', async () => {
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).toHaveBeenCalledTimes(1);
    expect(fetchSessionDetail).toHaveBeenCalledWith('project-1', 'lead-1', 'tab-1', {
      silent: false,
    });
  });

  it('does not fetch an already loaded lead session', async () => {
    storeState.tabSessionData = {
      'tab-1': {
        sessionDetail: { session: { id: 'lead-1' } },
        sessionDetailLoading: false,
      },
    };

    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).not.toHaveBeenCalled();
  });

  it('does not fetch while tab detail is loading', async () => {
    storeState.tabSessionData = {
      'tab-1': {
        sessionDetail: null,
        sessionDetailLoading: true,
      },
    };

    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).not.toHaveBeenCalled();
  });

  it('does not refetch the same attempted request on rerender', async () => {
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).toHaveBeenCalledTimes(1);
  });

  it('fetches again when the requested lead session changes', async () => {
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-2"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).toHaveBeenCalledTimes(2);
    expect(fetchSessionDetail).toHaveBeenLastCalledWith('project-1', 'lead-2', 'tab-1', {
      silent: false,
    });
  });

  it('allows retry after disabling and enabling the gate', async () => {
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled={false}
        />
      );
    });
    await act(async () => {
      root.render(
        <LeadSessionDetailGate
          tabId="tab-1"
          projectId="project-1"
          leadSessionId="lead-1"
          enabled
        />
      );
    });

    expect(fetchSessionDetail).toHaveBeenCalledTimes(2);
  });
});
