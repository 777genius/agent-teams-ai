import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TeamTabSectionNav } from '@renderer/components/layout/TeamTabSectionNav';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('TeamTabSectionNav', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStore.setState({ messagesPanelMode: 'inline' } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('labels the logs section as Logs in the section jump menu', async () => {
    await act(async () => {
      root.render(<TeamTabSectionNav teamName="demo-team" />);
      await Promise.resolve();
    });

    const trigger = host.querySelector('button[title="Jump to section"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    const menu = document.body.querySelector('[role="menu"]') as HTMLElement | null;
    expect(menu?.textContent).toContain('Logs');
    expect(menu?.textContent).not.toContain('Claude Logs');
  });
});
