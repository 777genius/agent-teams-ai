import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    resolvedTheme: 'dark',
    isDark: true,
    isLight: false,
  }),
}));

function member(name: string, overrides: Partial<ResolvedTeamMember> = {}): ResolvedTeamMember {
  return {
    name,
    status: 'active',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MemberSelect', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flush();
    });
    document.body.innerHTML = '';
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('preserves Create Task defaults for unassigned and lead display', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <MemberSelect
          members={[
            member('team-lead', { agentType: 'team-lead' }),
            member('alice', { role: 'reviewer' }),
          ]}
          value={null}
          onChange={onChange}
          allowUnassigned
        />
      );
      await flush();
    });

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Unassigned');
    expect(trigger.getAttribute('aria-label')).toBeNull();

    await act(async () => {
      trigger.click();
      await flush();
    });

    const list = document.body.querySelector('[cmdk-list]') as HTMLElement | null;
    expect(list?.textContent).toContain('Unassigned');
    expect(list?.textContent).toContain('lead');
    expect(list?.textContent).toContain('alice');
    expect(document.body.querySelector('input')?.getAttribute('placeholder')).toBe(
      'Search members...'
    );
  });

  it('supports custom log-source labels, descriptions, search text, and selection', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <MemberSelect
          members={[
            member('team-lead', { agentType: 'team-lead' }),
            member('Builder', { removedAt: 1715000000000 }),
            member('Reviewer', { role: 'reviewer' }),
          ]}
          value="team-lead"
          onChange={onChange}
          searchPlaceholder="Search log sources..."
          emptyMessage="No log sources found."
          ariaLabel="Log source"
          getMemberLabel={(candidate) => {
            if (candidate.name === 'team-lead') return 'Lead';
            if (candidate.removedAt) return `${candidate.name} (removed)`;
            return candidate.name;
          }}
          getMemberDescription={(candidate) => {
            if (candidate.name === 'team-lead') return 'Team Lead';
            if (candidate.removedAt) return 'Removed';
            return 'Reviewer';
          }}
        />
      );
      await flush();
    });

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Lead');
    expect(trigger.getAttribute('aria-label')).toBe('Log source');

    await act(async () => {
      trigger.click();
      await flush();
    });

    const input = document.body.querySelector('input') as HTMLInputElement;
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement | null;
    expect(input.getAttribute('placeholder')).toBe('Search log sources...');
    expect(list?.textContent).toContain('Lead');
    expect(list?.textContent).toContain('Team Lead');
    expect(list?.textContent).toContain('Builder (removed)');
    expect(list?.textContent).toContain('Removed');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'removed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });

    expect(list?.textContent).toContain('Builder (removed)');
    expect(list?.textContent).not.toContain('Reviewer');
    expect(list?.textContent).not.toContain('Team Lead');

    const builderItem = Array.from(list?.querySelectorAll('[cmdk-item]') ?? []).find((item) =>
      item.textContent?.includes('Builder (removed)')
    ) as HTMLElement | undefined;
    expect(builderItem).toBeDefined();

    await act(async () => {
      builderItem?.click();
      await flush();
    });

    expect(onChange).toHaveBeenCalledWith('Builder');
  });

  it('uses an avatar trigger for dense surfaces while keeping the full member list popover', async () => {
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
      await flush();
    });

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('Select member: Lead');
    expect(trigger?.getAttribute('title')).toBe('Lead');
    expect(host.textContent).not.toContain('Lead');

    await act(async () => {
      trigger?.click();
      await flush();
    });

    expect(document.body.textContent).toContain('Lead');
    expect(document.body.textContent).toContain('Alice');
  });
});
