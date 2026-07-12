import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { getTeamColorSet } from '@renderer/constants/teamColors';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/runtime-provider-management/renderer', () => ({
  OpenCodeLocalModelLimitsCard: () => React.createElement('div', null, 'local-model-limits-card'),
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: () => React.createElement('span', { 'data-testid': 'provider-logo' }),
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: () => React.createElement('div', null, 'effort-selector'),
}));

vi.mock('@renderer/components/team/dialogs/LimitContextCheckbox', () => ({
  LimitContextCheckbox: ({ disabled, scopeLabel }: { disabled?: boolean; scopeLabel?: string }) =>
    React.createElement(
      'div',
      null,
      ['limit-context', scopeLabel, disabled ? 'disabled' : 'enabled'].filter(Boolean).join(' ')
    ),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    'aria-expanded': ariaExpanded,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    'aria-expanded'?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      {
        className,
        disabled,
        onClick,
        type: 'button',
        'aria-expanded': ariaExpanded,
        'aria-label': ariaLabel,
      },
      children
    ),
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  formatTeamModelSummary: (providerId: string, model: string, effort?: string) =>
    [providerId, model || 'Default', effort].filter(Boolean).join(' · '),
  getProviderScopedTeamModelLabel: (_providerId: string, model: string) => model || 'Default',
  getTeamEffortLabel: (effort: string) => effort || 'Default',
  getTeamProviderLabel: (providerId: string) => providerId,
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
  isAnthropicSonnetOneMillionContextTeamModel: (model: string | undefined) =>
    model === 'sonnet[1m]' || model === 'claude-sonnet-4-6' || model === 'claude-sonnet-4-6[1m]',
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

import { ANTHROPIC_LONG_CONTEXT_PRICING_URL, LeadModelRow } from './LeadModelRow';

function renderLeadModelRow(overrides: Partial<React.ComponentProps<typeof LeadModelRow>> = {}): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
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
        ...overrides,
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

  it('warns that unchecked 200K limit can affect Sonnet 1M billing by plan/runtime', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'anthropic',
      model: 'sonnet[1m]',
      limitContext: false,
    });

    expect(host.textContent).toContain('Sonnet 1M context can affect billing');
    expect(host.textContent).toContain('standard API pricing');
    expect(host.textContent).toContain('Extra Usage for Sonnet 1M');
    const docsLink = host.querySelector(`a[href="${ANTHROPIC_LONG_CONTEXT_PRICING_URL}"]`);

    expect(docsLink?.textContent).toContain('Anthropic pricing docs');
    expect(docsLink?.getAttribute('target')).toBe('_blank');
    expect(docsLink?.getAttribute('rel')).toBe('noreferrer');

    act(() => {
      root.unmount();
    });
  });

  it('does not show the Sonnet Extra Usage warning when 200K limit is enabled', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'anthropic',
      model: 'sonnet[1m]',
      limitContext: true,
    });

    expect(host.textContent).not.toContain('Anthropic Extra Usage');

    act(() => {
      root.unmount();
    });
  });

  it('does not show the Sonnet Extra Usage warning for standard-context Sonnet', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'anthropic',
      model: 'sonnet',
      limitContext: false,
    });

    expect(host.textContent).not.toContain('Anthropic Extra Usage');

    act(() => {
      root.unmount();
    });
  });

  it('warns for native 1M Sonnet launch ids without an explicit suffix', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
      limitContext: false,
    });

    expect(host.textContent).toContain('Sonnet 1M context can affect billing');

    act(() => {
      root.unmount();
    });
  });

  it('shows the team-wide Anthropic context control when only teammates use Anthropic', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'codex',
      model: 'gpt-5.4',
      showAnthropicContextLimit: true,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="codex provider, gpt-5.4"]'
    )!;
    act(() => {
      modelButton.click();
    });

    expect(host.textContent).toContain('limit-context Anthropic team-wide');
    expect(host.textContent).toContain(
      'The 200K context limit is team-wide for Anthropic runtimes'
    );

    act(() => {
      root.unmount();
    });
  });

  it('honors the explicit disabled state for the Anthropic context control', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'anthropic',
      model: 'haiku',
      disableAnthropicContextLimit: true,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="anthropic provider, haiku"]'
    )!;
    act(() => {
      modelButton.click();
    });

    expect(host.textContent).toContain('limit-context disabled');

    act(() => {
      root.unmount();
    });
  });

  it('shows local OpenCode limit controls inside OpenCode provider settings after effort', () => {
    const { host, root } = renderLeadModelRow({
      providerId: 'opencode',
      model: 'local/model',
      showAnthropicContextLimit: false,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="opencode provider, local/model"]'
    )!;
    act(() => {
      modelButton.click();
    });

    const text = host.textContent ?? '';
    const effortIndex = text.indexOf('effort-selector');
    const hintIndex = text.indexOf('local-model-limits-card');

    expect(hintIndex).toBeGreaterThan(-1);
    expect(effortIndex).toBeGreaterThan(-1);
    expect(hintIndex).toBeGreaterThan(effortIndex);

    act(() => {
      root.unmount();
    });
  });
});
