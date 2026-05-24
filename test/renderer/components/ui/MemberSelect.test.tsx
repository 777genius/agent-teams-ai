import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

function member(name: string): ResolvedTeamMember {
  return {
    name,
    status: 'active',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
  };
}

describe('MemberSelect', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses an avatar trigger for dense surfaces while keeping the full member list popover', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <MemberSelect
          members={[member('Lead'), member('Alice')]}
          value="Lead"
          onChange={onChange}
          triggerVariant="avatar"
        />
      );
      await Promise.resolve();
    });

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('Select member: Lead');
    expect(trigger?.getAttribute('title')).toBe('Lead');
    expect(host.textContent).not.toContain('Lead');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Lead');
    expect(document.body.textContent).toContain('Alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
