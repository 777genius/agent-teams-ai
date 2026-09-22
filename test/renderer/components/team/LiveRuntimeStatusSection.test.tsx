import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRuntimeStatusSection } from '@renderer/components/team/LiveRuntimeStatusSection';

describe('LiveRuntimeStatusSection', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders display-only runtime rows without process actions', async () => {
    await act(async () => {
      root.render(
        <LiveRuntimeStatusSection
          rows={[
            {
              memberName: 'alice',
              state: 'running',
              stateReason: 'Runtime heartbeat is alive',
              source: 'runtime',
              runtimeModel: 'claude-sonnet-4.5',
              pidLabel: 'runtime pid 1234',
              actionsAllowed: false,
            },
          ]}
        />
      );
    });

    expect(host.textContent).toContain('Live runtime status');
    expect(host.textContent).toContain('Display-only heartbeat and launch state');
    expect(host.textContent).toContain('alice');
    expect(host.textContent).toContain('runtime pid 1234');
    expect(host.textContent).not.toContain('Kill');
    expect(host.textContent).not.toContain('Open');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
