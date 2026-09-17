import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationHeader } from './ConversationHeader';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => (key === 'messages.chats.teamFeed' ? 'This team' : key),
  }),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name, variant }: { name: string; variant?: string }) =>
    React.createElement('span', { 'data-member-badge': name, 'data-variant': variant }, name),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    type,
    className,
    onClick,
    onPointerDown,
    'aria-label': ariaLabel,
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) =>
    React.createElement(
      'button',
      { type, className, onClick, onPointerDown, 'aria-label': ariaLabel },
      children
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

afterEach(() => {
  document.body.innerHTML = '';
});

async function renderHeader(props: { title: string; onBack?: () => void }): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConversationHeader
        title={props.title}
        unreadCount={0}
        attentionCount={0}
        onBack={props.onBack}
      />
    );
    await Promise.resolve();
  });
  return host;
}

describe('ConversationHeader participant identity', () => {
  it('renders the member badge next to back for a direct chat', async () => {
    const host = await renderHeader({ title: 'team-lead', onBack: () => undefined });
    const badge = host.querySelector('[data-member-badge="team-lead"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-variant')).toBe('text');
    expect(host.querySelector('button[aria-label="messages.chats.back"]')).not.toBeNull();
  });

  it('keeps the This team label as plain text', async () => {
    const host = await renderHeader({ title: 'This team', onBack: () => undefined });
    expect(host.querySelector('[data-member-badge]')).toBeNull();
    expect(host.textContent).toContain('This team');
  });

  it('keeps the chat-list title as plain text', async () => {
    const host = await renderHeader({ title: 'Messages' });
    expect(host.querySelector('[data-member-badge]')).toBeNull();
    expect(host.textContent).toContain('Messages');
  });
});
