import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessagesConversationSkeleton } from './MessagesConversationSkeleton';

afterEach(() => {
  document.body.innerHTML = '';
});

async function renderSkeleton(props: {
  surface: 'list' | 'thread';
  scope: { kind: 'team-feed' } | { kind: 'direct'; participant: string };
  title: string;
}): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MessagesConversationSkeleton
        surface={props.surface}
        scope={props.scope}
        title={props.title}
      />
    );
    await Promise.resolve();
  });
  const skeleton = host.querySelector<HTMLElement>('[data-messages-skeleton]');
  if (!skeleton) throw new Error('Expected messages skeleton');
  return skeleton;
}

describe('MessagesConversationSkeleton', () => {
  it('shows a chat-list placeholder without composer or thread cards', async () => {
    const skeleton = await renderSkeleton({
      surface: 'list',
      scope: { kind: 'team-feed' },
      title: 'Messages',
    });

    expect(skeleton.getAttribute('data-messages-skeleton')).toBe('list');
    expect(skeleton.getAttribute('data-messages-skeleton-title')).toBe('Messages');
    expect(skeleton.querySelector('.lucide-arrow-left')).toBeNull();
    expect(skeleton.querySelector('.message-composer-flat-layout')).toBeNull();
    expect(skeleton.querySelectorAll('.lucide-message-square')).toHaveLength(1);
    expect(skeleton.textContent).toContain('Messages');
  });

  it('shows the selected chat header, composer, and message cards', async () => {
    const skeleton = await renderSkeleton({
      surface: 'thread',
      scope: { kind: 'direct', participant: 'alice' },
      title: 'alice',
    });

    expect(skeleton.getAttribute('data-messages-skeleton')).toBe('thread');
    expect(skeleton.getAttribute('data-messages-skeleton-title')).toBe('alice');
    expect(skeleton.querySelector('.lucide-arrow-left')).not.toBeNull();
    expect(skeleton.querySelector('.message-composer-flat-layout')).not.toBeNull();
    expect(skeleton.textContent).toContain('alice');
  });
});
