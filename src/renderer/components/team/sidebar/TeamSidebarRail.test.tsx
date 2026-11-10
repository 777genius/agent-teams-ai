import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ClaudeLogsSection', () => ({
  ClaudeLogsSection: ({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) => (
    <button type="button" data-testid="open-logs" onClick={() => onOpenChange?.(true)}>
      logs
    </button>
  ),
}));

vi.mock('../messages/MessagesPanel', () => ({
  MessagesPanel: () => <div data-testid="messages-panel">messages</div>,
}));

import { TeamSidebarRail } from './TeamSidebarRail';

const mountedRoots: Root[] = [];

async function renderRail(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <TeamSidebarRail
        teamName="demo-team"
        messagesPanelProps={{ onPositionChange: vi.fn() } as never}
        isResizing={false}
        onResizeMouseDown={vi.fn()}
        logsHeight={213}
        logsHeightIsCustom
        isLogsResizing={false}
        onLogsResizeMouseDown={vi.fn()}
        onApplyDefaultLogsHeight={vi.fn()}
      />
    );
    await Promise.resolve();
  });

  return container;
}

describe('TeamSidebarRail', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps messages above a collapsed logs strip at the bottom of the sidebar', async () => {
    const container = await renderRail();
    const messages = container.querySelector('[data-team-sidebar-messages]');
    const logs = container.querySelector('[data-team-sidebar-logs]');

    expect(messages).not.toBeNull();
    expect(logs).not.toBeNull();
    expect(
      Boolean(messages!.compareDocumentPosition(logs!) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
    expect(container.querySelector('[data-team-sidebar-logs-resize]')).toBeNull();
  });

  it('shows the vertical logs resize handle only after logs are expanded', async () => {
    const container = await renderRail();
    const openLogs = container.querySelector<HTMLButtonElement>('[data-testid="open-logs"]');
    if (!openLogs) throw new Error('Expected logs toggle');

    await act(async () => {
      openLogs.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-team-sidebar-logs-resize]')).not.toBeNull();
  });
});
