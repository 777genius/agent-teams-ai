import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { getTeamColorSet } from '@renderer/constants/teamColors';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: () => React.createElement('span', { 'data-testid': 'provider-logo' }),
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: () => React.createElement('div', null, 'effort-selector'),
}));

vi.mock('@renderer/components/team/dialogs/LimitContextCheckbox', () => ({
  LimitContextCheckbox: () => React.createElement('div', null, 'limit-context'),
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  getProviderScopedTeamModelLabel: (_providerId: string, model: string) => model || 'Default',
  getTeamProviderLabel: (providerId: string) => providerId,
  OPENCODE_TEAM_LEAD_DISABLED_BADGE_LABEL: 'side lane',
  OPENCODE_TEAM_LEAD_DISABLED_REASON:
    'OpenCode is teammate-only in this phase. Use Anthropic, Codex, or Gemini as the team lead, then add OpenCode as a teammate.',
  TeamModelSelector: () => React.createElement('div', null, 'team-model-selector'),
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

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) =>
    React.createElement('label', props, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/utils/teamModelCatalog', () => ({
  isAnthropicHaikuTeamModel: () => false,
}));

vi.mock('../../ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      { className, disabled, onClick, type: 'button', 'aria-label': ariaLabel },
      children
    ),
}));

import { LeadModelRow } from './LeadModelRow';

function renderLeadModelRow(): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      React.createElement(LeadModelRow, {
        providerId: 'anthropic',
        model: 'opus',
        effort: 'medium',
        limitContext: false,
        onProviderChange: () => undefined,
        onModelChange: () => undefined,
        onEffortChange: () => undefined,
        onLimitContextChange: () => undefined,
        syncModelsWithTeammates: true,
        onSyncModelsWithTeammatesChange: () => undefined,
      })
    );
  });

  return { host, root };
}

describe('LeadModelRow', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the canonical team-lead color for the preview stripe', () => {
    const { host, root } = renderLeadModelRow();

    const stripe = host.querySelector('[aria-hidden="true"]');
    const expectedBorder = getTeamColorSet(resolveTeamLeadColorName()).border;

    expect(host.textContent).toContain('lead');
    expect(host.textContent).toContain('Team Lead');
    expect(stripe?.getAttribute('style')).toContain(expectedBorder);

    act(() => {
      root.unmount();
    });
  });
});
