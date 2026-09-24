import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { LatestMessageControl } from '@renderer/components/team/messages/MessagesExpandedChrome';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('LatestMessageControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows the unread below count on the round button and hides it at zero', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = async (unreadBelowCount: number) => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <LatestMessageControl
              label="To latest"
              onReveal={() => undefined}
              unreadBelowCount={unreadBelowCount}
            />
          </TooltipProvider>
        );
      });
    };

    await render(3);
    expect(host.querySelector('[data-conversation-unread-below]')?.textContent).toBe('3');
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('To latest (3)');
    await render(0);
    expect(host.querySelector('[data-conversation-unread-below]')).toBeNull();
    await act(async () => root.unmount());
  });
});
