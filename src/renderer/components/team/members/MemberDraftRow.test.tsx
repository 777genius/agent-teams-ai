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
  getTeamEffortLabel: (effort: string) => effort || 'Default',
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
    'aria-expanded': ariaExpanded,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    title?: string;
    'aria-describedby'?: string;
    'aria-expanded'?: boolean;
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
        'aria-expanded': ariaExpanded,
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

  it('renders workflow and MCP row controls as icon-only buttons with tooltip text', () => {
    const { host, root } = renderMemberDraftRow({
      showWorkflow: true,
      onWorkflowChange: () => undefined,
      onMcpPolicyChange: () => undefined,
    });

    const workflowButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Add teammate workflow"]'
    )!;
    const mcpButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) =>
        button.getAttribute('aria-label') ===
        "MCP inherit: Control this member's MCP inheritance policy"
    )!;
    const removeButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove alice"]'
    )!;

    expect(workflowButton).toBeTruthy();
    expect(workflowButton.textContent).not.toContain('Workflow');
    expect(workflowButton.closest('[title]')?.getAttribute('title')).toBe('Add teammate workflow');
    expect(workflowButton.getAttribute('aria-expanded')).toBe('false');

    expect(mcpButton).toBeTruthy();
    expect(mcpButton.textContent).not.toContain('MCP');
    expect(mcpButton.textContent).not.toContain('inherit');
    const mcpTooltipWrapper = mcpButton.closest('[title]');
    const mcpTooltipContent = Array.from(mcpTooltipWrapper?.children ?? []).find(
      (element) => element.getAttribute('aria-hidden') === 'true'
    );
    expect(mcpTooltipWrapper?.getAttribute('title')).toBe(
      "MCP inherit: Control this member's MCP inheritance policy"
    );
    expect(mcpTooltipContent?.getAttribute('class')).toContain(
      'group-hover/hover-tooltip:opacity-100'
    );
    expect(mcpButton.getAttribute('aria-expanded')).toBe('false');
    expect(
      workflowButton.compareDocumentPosition(mcpButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      mcpButton.compareDocumentPosition(removeButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    act(() => {
      workflowButton.click();
      mcpButton.click();
    });

    expect(workflowButton.getAttribute('aria-expanded')).toBe('true');
    expect(mcpButton.getAttribute('aria-expanded')).toBe('true');
    expect(mcpButton.className).toContain('border-sky-400/45');
    expect(mcpTooltipWrapper?.getAttribute('title')).toBeNull();
    expect(mcpTooltipContent?.getAttribute('class')).not.toContain(
      'group-hover/hover-tooltip:opacity-100'
    );
    expect(host.textContent).toContain('Workflow (optional)');
    expect(host.textContent).toContain('MCP mode');

    act(() => {
      root.unmount();
    });
  });

  it.each([
    {
      label: 'inherit lead',
      mcpPolicy: undefined,
      ariaLabel: "MCP inherit: Control this member's MCP inheritance policy",
      highlightedBeforeClick: false,
    },
    {
      label: 'agent teams mcp',
      mcpPolicy: { mode: 'appOnly' as const },
      ariaLabel: "Agent Teams MCP: Control this member's MCP inheritance policy",
      highlightedBeforeClick: true,
    },
    {
      label: 'scope inheritance',
      mcpPolicy: {
        mode: 'inheritScopes' as const,
        scopes: { user: true, project: false, local: true },
      },
      ariaLabel: "MCP scopes: Control this member's MCP inheritance policy",
      highlightedBeforeClick: true,
    },
    {
      label: 'strict allowlist',
      mcpPolicy: {
        mode: 'strictAllowlist' as const,
        scopes: { user: true, project: true, local: false },
        serverNames: ['github', 'linear'],
      },
      ariaLabel: "MCP 2: Control this member's MCP inheritance policy",
      highlightedBeforeClick: true,
    },
  ])(
    'keeps MCP control state correct across $label settings in the row fixture e2e',
    ({ mcpPolicy, ariaLabel, highlightedBeforeClick }) => {
      const { host, root } = renderMemberDraftRow({
        member: createMemberDraft({
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          providerId: 'anthropic',
          model: 'opus',
          mcpPolicy,
        }),
        onMcpPolicyChange: () => undefined,
      });

      const mcpButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.getAttribute('aria-label') === ariaLabel
      )!;
      const tooltipWrapper = mcpButton.closest('[title]');
      const tooltipContent = Array.from(tooltipWrapper?.children ?? []).find(
        (element) => element.getAttribute('aria-hidden') === 'true'
      );

      expect(mcpButton).toBeTruthy();
      expect(mcpButton.textContent).not.toContain('MCP');
      expect(mcpButton.className.includes('border-sky-400/45')).toBe(highlightedBeforeClick);
      expect(tooltipWrapper?.getAttribute('title')).toBe(ariaLabel);
      expect(tooltipContent?.getAttribute('class')).toContain(
        'group-hover/hover-tooltip:opacity-100'
      );

      act(() => {
        mcpButton.click();
      });

      expect(mcpButton.getAttribute('aria-expanded')).toBe('true');
      expect(mcpButton.className).toContain('border-sky-400/45');
      expect(tooltipWrapper?.getAttribute('title')).toBeNull();
      expect(tooltipContent?.getAttribute('class')).not.toContain(
        'group-hover/hover-tooltip:opacity-100'
      );
      expect(host.textContent).toContain('MCP mode');

      act(() => {
        root.unmount();
      });
    }
  );

  it('locks MCP controls when Agent Teams MCP master mode is enabled', () => {
    const onMcpPolicyChange = vi.fn();
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: 'anthropic',
        model: 'opus',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: true, project: true, local: true },
          serverNames: ['github'],
        },
      }),
      onMcpPolicyChange,
      agentTeamsMcpLocked: true,
    });

    const mcpButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) =>
        button.getAttribute('aria-label') ===
        "Agent Teams MCP: Control this member's MCP inheritance policy"
    )!;

    expect(mcpButton).toBeTruthy();
    expect(mcpButton.className).toContain('border-amber-300/50');
    expect(mcpButton.querySelector('.bg-amber-300')).toBeTruthy();

    act(() => {
      mcpButton.click();
    });

    expect(host.textContent).toContain('MCP mode');
    expect(host.textContent).toContain('Agent Teams MCP');
    expect(host.textContent).toContain(
      'Agent Teams MCP only is enabled for all teammates. This teammate will launch with only the Agent Teams server.'
    );

    const mcpModeTrigger = host.querySelector<HTMLButtonElement>('#member-member-1-mcp-mode')!;
    const scopeCheckboxes = Array.from(
      host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );

    expect(mcpModeTrigger.disabled).toBe(true);
    expect(scopeCheckboxes).toHaveLength(3);
    expect(scopeCheckboxes.every((checkbox) => checkbox.disabled)).toBe(true);

    act(() => {
      scopeCheckboxes[0]?.click();
    });

    expect(onMcpPolicyChange).not.toHaveBeenCalled();

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

  it('lets an Anthropic teammate toggle the team-wide 200K context limit inline', () => {
    const onLimitContextChange = vi.fn();
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
      }),
      limitContext: false,
      onLimitContextChange,
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="anthropic provider, claude-sonnet-5"]'
    )!;
    act(() => {
      modelButton.click();
    });

    expect(host.textContent).toContain('Limit context to 200K tokens');
    expect(host.textContent).toContain('Anthropic team-wide');

    const limitContextCheckbox = host.querySelector<HTMLInputElement>(
      '#member-member-1-limit-context'
    )!;
    act(() => {
      limitContextCheckbox.click();
    });

    expect(onLimitContextChange).toHaveBeenCalledWith(true);

    act(() => {
      root.unmount();
    });
  });

  it('shows the OpenCode context config hint inside OpenCode teammate provider settings after effort', () => {
    const { host, root } = renderMemberDraftRow({
      member: createMemberDraft({
        id: 'member-1',
        name: 'alice',
        roleSelection: 'developer',
        providerId: 'opencode',
        model: 'local/model',
      }),
    });

    const modelButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="opencode provider, local/model"]'
    )!;
    act(() => {
      modelButton.click();
    });

    const text = host.textContent ?? '';
    const effortIndex = text.indexOf('effort-selector');
    const hintIndex = text.indexOf('OpenCode local models can use an OpenCode context budget');

    expect(hintIndex).toBeGreaterThan(-1);
    expect(effortIndex).toBeGreaterThan(-1);
    expect(hintIndex).toBeGreaterThan(effortIndex);

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
