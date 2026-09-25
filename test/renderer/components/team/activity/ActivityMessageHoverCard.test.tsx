import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ActivityMessageHoverCard } from '@renderer/components/team/activity/ActivityMessageHoverCard';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ActivityMessageHoverCard floating composer layering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps the wide message toolbar inside the scroll layer when a floating footer is present', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.setAttribute('data-messages-thread-scroll', 'true');
    const fade = document.createElement('div');
    fade.setAttribute('data-messages-thread-footer-fade', 'true');
    host.append(scroll, fade);
    document.body.appendChild(host);

    const root = createRoot(scroll);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityMessageHoverCard
            appearance="wide-chat"
            copyText="Message"
            showToolbar
            canRevise={false}
          >
            <article tabIndex={0}>Message</article>
          </ActivityMessageHoverCard>
        </TooltipProvider>
      );
      await Promise.resolve();
    });

    await act(async () => {
      scroll.querySelector('article')?.focus();
      await Promise.resolve();
    });

    expect(scroll.querySelector('[data-chat-toolbar-appearance="wide-chat"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
