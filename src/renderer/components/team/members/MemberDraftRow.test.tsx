import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

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
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      { type: 'button', onClick, disabled, 'aria-label': ariaLabel },
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

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
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

import { createMemberDraft } from './membersEditorUtils';
import { MemberDraftRow } from './MemberDraftRow';

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
});
