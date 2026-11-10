import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./MessageComposer', () => ({
  MessageComposer: React.forwardRef<
    HTMLTextAreaElement,
    { textareaRef?: React.Ref<HTMLTextAreaElement> }
  >(function MockMessageComposer({ textareaRef }, _ref) {
    return React.createElement('textarea', {
      'aria-label': 'Message',
      ref: textareaRef,
    });
  }),
}));

import { ThreadAwareMessageComposer } from './ThreadAwareMessageComposer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ThreadAwareMessageComposer', () => {
  it('autofocuses the composer when a chat thread mounts', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ThreadAwareMessageComposer, {
          teamName: 'demo',
          members: [],
          sending: false,
          sendError: null,
          onSend: vi.fn(),
        })
      );
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    expect(document.activeElement).toBe(host.querySelector('textarea[aria-label="Message"]'));

    await act(async () => {
      root.unmount();
    });
  });
});
