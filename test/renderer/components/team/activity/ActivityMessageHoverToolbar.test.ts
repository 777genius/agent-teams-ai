import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ActivityMessageHoverToolbar } from '@renderer/components/team/activity/ActivityMessageHoverToolbar';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

describe('ActivityMessageHoverToolbar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a vertical action column with copy, reply, and create-task controls', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onReply = vi.fn();
    const onCreateTask = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await act(async () => {
      root.render(
        React.createElement(ActivityMessageHoverToolbar, {
          copyText: 'hello from the message',
          onReply,
          onCreateTask,
        })
      );
      await Promise.resolve();
    });

    const toolbar = host.querySelector('[data-activity-message-toolbar="true"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.getAttribute('data-orientation')).toBe('vertical');
    expect(toolbar?.className).toContain('flex-col');
    expect(host.querySelector('button[aria-label="Edit message"]')).toBeNull();

    const replyButton = host.querySelector('button[aria-label="Reply to message"]');
    const createButton = host.querySelector('button[aria-label="Create task from message"]');
    const copyButton = host.querySelector('button[aria-label="Copy to clipboard"]');
    expect(replyButton).not.toBeNull();
    expect(createButton).not.toBeNull();
    expect(copyButton).not.toBeNull();

    await act(async () => {
      (replyButton as HTMLButtonElement).click();
      (createButton as HTMLButtonElement).click();
      (copyButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello from the message');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.unstubAllGlobals();
  });
});
