import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ANTHROPIC_LONG_CONTEXT_PRICING_URL } from '@renderer/components/team/dialogs/AnthropicExtraUsageWarning';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: () => React.createElement('span', { 'data-testid': 'provider-logo' }),
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: () => React.createElement('div', null, 'effort-selector'),
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  formatTeamModelSummary: (providerId: string, model: string, effort?: string) =>
    [providerId, model || 'Default', effort].filter(Boolean).join(' · '),
  getProviderScopedTeamModelLabel: (_providerId: string, model: string) => model || 'Default',
  getTeamProviderLabel: (providerId: string) => providerId,
  TeamModelSelector: () => React.createElement('div', null, 'team-model-selector'),
}));

vi.mock('@renderer/components/team/RoleSelect', () => ({
  RoleSelect: ({ value }: { value: string }) => React.createElement('div', null, value),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    title,
    'aria-describedby': ariaDescribedBy,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    title?: string;
    'aria-describedby'?: string;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        className,
        onClick,
        disabled,
        title,
        'aria-describedby': ariaDescribedBy,
        'aria-label': ariaLabel,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
  }) =>
    React.createElement('input', {
      ...props,
      checked,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { value?: string }) =>
    React.createElement('input', { ...props, value, onChange, type: 'text' }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) =>
    React.createElement('label', props, children),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: () => React.createElement('textarea'),
}));

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: ({ initialValue }: { initialValue?: string }) => ({
    value: initialValue ?? '',
    setValue: () => undefined,
    isSaved: true,
  }),
}));

vi.mock('@renderer/hooks/useFileListCacheWarmer', () => ({
  useFileListCacheWarmer: () => undefined,
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

import { MemberDraftRow } from './MemberDraftRow';
import { createMemberDraft } from './membersEditorUtils';

function renderMemberDraftRow(props: Partial<React.ComponentProps<typeof MemberDraftRow>> = {}): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      React.createElement(MemberDraftRow, {
        member: createMemberDraft({
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          providerId: 'anthropic',
          model: 'opus',
        }),
        index: 0,
        nameError: null,
        onNameChange: () => undefined,
        onRoleChange: () => undefined,
        onCustomRoleChange: () => undefined,
        onRemove: () => undefined,
        onProviderChange: () => undefined,
        onModelChange: () => undefined,
        onEffortChange: () => undefined,
        ...props,
      })
    );
  });

  return { host, root };
}

describe('MemberDraftRow', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not show the sync tooltip copy when model controls are unlocked', () => {
    const { host, root } = renderMemberDraftRow({
      lockProviderModel: false,
      forceInheritedModelSettings: false,
      modelLockReason:
        'This teammate is synced with the lead model. Turn off sync to set a custom provider, model, or effort.',
    });

    expect(host.textContent).not.toContain('This teammate is synced with the lead model');

    act(() => {
      root.unmount();
    });
  });

  it('shows inherited model copy when sync is enabled', () => {
    const { host, root } = renderMemberDraftRow({
      lockProviderModel: true,
      forceInheritedModelSettings: true,
    });

    expect(host.textContent).toContain(
      'Provider, model, and effort are inherited from the lead while sync is enabled.'
    );

    act(() => {
      root.unmount();
    });
  });

  it('explains that Anthropic context limit is team-wide for teammate overrides', () => {
    const { host, root } = renderMemberDraftRow({
      limitContext: true,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="anthropic provider, opus"]'
    )!;
    act(() => {
      modelButton.click();
    });

    expect(host.textContent).toContain('Anthropic context is team-wide for this launch');
    expect(host.textContent).toContain('200K limit enabled');

    act(() => {
      root.unmount();
    });
  });

  it('shows model launch issues inline and keeps model controls expandable', () => {
    const issueText =
      'Member alice uses Anthropic effort "medium", but Haiku 4.5 does not support it in the current runtime.';
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        effort: 'medium',
      }),
      modelIssueText: issueText,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="anthropic provider, claude-haiku-4-5-20251001"]'
    )!;

    expect(host.textContent).toContain(issueText);
    expect(modelButton.getAttribute('aria-describedby')).toContain('member-member-1-model-issue');
    expect(modelButton.parentElement?.getAttribute('title')).toBe(issueText);

    act(() => {
      modelButton.click();
    });

    expect(host.textContent).toContain('team-model-selector');
    expect(host.textContent).toContain('effort-selector');

    act(() => {
      root.unmount();
    });
  });

  it('renders worktree isolation help without a Radix tooltip trigger', () => {
    const { host, root } = renderMemberDraftRow({
      showWorktreeIsolationControls: true,
      worktreeIsolationDisabledReason: 'Worktree isolation is disabled for this project.',
    });

    const worktreeControl = host.querySelector<HTMLInputElement>(
      '#member-member-1-worktree-isolation'
    )!;
    const descriptionId = 'member-member-1-worktree-isolation-description';
    const wrapper = worktreeControl.closest('[title]');

    expect(worktreeControl.getAttribute('aria-describedby')).toBe(descriptionId);
    expect(wrapper?.getAttribute('title')).toBe('Worktree isolation is disabled for this project.');
    expect(host.querySelector(`#${descriptionId}`)?.textContent).toBe(
      'Worktree isolation is disabled for this project.'
    );

    act(() => {
      root.unmount();
    });
  });

  it('warns custom Anthropic Sonnet teammates about plan/runtime billing when 200K limit is off', () => {
    const { host, root } = renderMemberDraftRow({
      member: {
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        customRole: '',
        providerId: 'anthropic',
        model: 'sonnet[1m]',
      },
      limitContext: false,
    });

    expect(host.textContent).toContain('Sonnet 1M context can affect billing');
    expect(host.textContent).toContain('Extra Usage for Sonnet 1M');
    const docsLink = host.querySelector(`a[href="${ANTHROPIC_LONG_CONTEXT_PRICING_URL}"]`);

    expect(docsLink?.textContent).toContain('Anthropic pricing docs');

    act(() => {
      root.unmount();
    });
  });

  it('does not warn standard-context Anthropic Sonnet teammates about Extra Usage', () => {
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: 'anthropic',
        model: 'sonnet',
      }),
      limitContext: false,
    });

    expect(host.textContent).not.toContain('Anthropic Extra Usage');

    act(() => {
      root.unmount();
    });
  });

  it('does not duplicate the Sonnet Extra Usage warning for effort-only inherited teammates', () => {
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: undefined,
        model: '',
        effort: 'max',
      }),
      inheritedProviderId: 'anthropic',
      inheritedModel: 'sonnet[1m]',
      limitContext: false,
    });

    expect(host.textContent).not.toContain('Anthropic Extra Usage');

    act(() => {
      root.unmount();
    });
  });
});
