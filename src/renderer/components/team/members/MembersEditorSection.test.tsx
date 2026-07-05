import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    title,
    className,
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        className,
        disabled,
        title,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange'> & {
    checked?: boolean | 'indeterminate';
    onCheckedChange?: (value: boolean | 'indeterminate') => void;
  }) =>
    React.createElement('input', {
      ...props,
      checked: checked === true,
      'data-state':
        checked === 'indeterminate' ? 'indeterminate' : checked ? 'checked' : 'unchecked',
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

vi.mock('../dialogs/MembersJsonEditor', () => ({
  MembersJsonEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    React.createElement('textarea', {
      'data-testid': 'members-json-editor',
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    }),
}));

vi.mock('./MemberDraftRow', () => ({
  MemberDraftRow: ({
    member,
    onWorktreeIsolationChange,
    onRemove,
    onRestore,
    onModelChange,
    agentTeamsMcpLocked,
  }: {
    member: {
      id: string;
      name: string;
      isolation?: 'worktree';
      model?: string;
      effort?: string;
      mcpPolicy?: { mode?: string };
      removedAt?: number | string | null;
    };
    onWorktreeIsolationChange?: (id: string, enabled: boolean) => void;
    onRemove?: (id: string) => void;
    onRestore?: (id: string) => void;
    onModelChange?: (id: string, model: string) => void;
    agentTeamsMcpLocked?: boolean;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': `member-${member.name}`,
          'data-isolation': member.isolation ?? '',
          'data-mcp-policy': member.mcpPolicy?.mode ?? '',
          'data-agent-teams-mcp-locked': agentTeamsMcpLocked ? 'true' : 'false',
          'data-removed': member.removedAt ? 'true' : 'false',
          onClick: () => onWorktreeIsolationChange?.(member.id, member.isolation !== 'worktree'),
        },
        member.name
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': `remove-${member.name}`,
          onClick: () => onRemove?.(member.id),
        },
        'remove'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': `restore-${member.name}`,
          onClick: () => onRestore?.(member.id),
        },
        'restore'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': `model-${member.name}`,
          'data-model': member.model ?? '',
          'data-effort': member.effort ?? '',
          onClick: () => onModelChange?.(member.id, 'claude-haiku-4-5-20251001'),
        },
        'select haiku'
      )
    ),
}));

import { MembersEditorSection } from './MembersEditorSection';
import { createMemberDraft } from './membersEditorUtils';

import type { MemberDraft } from './membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

const mountedRoots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

function renderMembersEditor(props: {
  members: MemberDraft[];
  teammateWorktreeDefault?: boolean;
  onChange?: (members: MemberDraft[]) => void;
  softDeleteMembers?: boolean;
  inheritedProviderId?: TeamProviderId;
  inheritedEffort?: React.ComponentProps<typeof MembersEditorSection>['inheritedEffort'];
  limitContext?: boolean;
  runtimeProviderStatusById?: ReadonlyMap<TeamProviderId, CliProviderStatus>;
}): {
  host: HTMLDivElement;
  onChange: ReturnType<typeof vi.fn>;
  rerender: (members: MemberDraft[]) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onChange = props.onChange ?? vi.fn();

  const render = (members: MemberDraft[]): void => {
    root.render(
      <MembersEditorSection
        members={members}
        onChange={onChange}
        showWorktreeIsolationControls
        teammateWorktreeDefault={props.teammateWorktreeDefault}
        softDeleteMembers={props.softDeleteMembers}
        inheritedProviderId={props.inheritedProviderId}
        inheritedEffort={props.inheritedEffort}
        limitContext={props.limitContext}
        runtimeProviderStatusById={props.runtimeProviderStatusById}
        draftKeyPrefix="worktree-test"
      />
    );
  };

  act(() => {
    render(props.members);
  });

  return {
    host,
    onChange: onChange as ReturnType<typeof vi.fn>,
    rerender: (members: MemberDraft[]) => {
      act(() => render(members));
    },
  };
}

function masterWorktreeCheckbox(host: HTMLElement): HTMLInputElement {
  const checkbox = host.querySelector<HTMLInputElement>('#teammate-worktree-default-worktree-test');
  if (!checkbox) {
    throw new Error('Master worktree checkbox not found');
  }
  return checkbox;
}

function masterAgentTeamsMcpCheckbox(host: HTMLElement): HTMLInputElement {
  const checkbox = host.querySelector<HTMLInputElement>(
    '#teammate-agent-teams-mcp-default-worktree-test'
  );
  if (!checkbox) {
    throw new Error('Master Agent Teams MCP checkbox not found');
  }
  return checkbox;
}

function addMemberButton(host: HTMLElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((element) =>
    element.textContent?.includes('Add member')
  );
  if (!button) {
    throw new Error('Add member button not found');
  }
  return button;
}

function editJsonButton(host: HTMLElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((element) =>
    element.textContent?.includes('Edit as JSON')
  );
  if (!button) {
    throw new Error('Edit as JSON button not found');
  }
  return button;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = '';
});

describe('MembersEditorSection runtime model selection', () => {
  it('clears stale teammate effort immediately when selecting a model without effort support', () => {
    const { host, onChange } = renderMembersEditor({
      inheritedProviderId: 'anthropic',
      inheritedEffort: 'medium',
      members: [
        createMemberDraft({
          id: 'alice',
          name: 'alice',
          providerId: 'anthropic',
          model: 'claude-sonnet-5',
          effort: 'medium',
        }),
      ],
      runtimeProviderStatusById: new Map([['anthropic', anthropicStatusWithHaikuWithoutEffort()]]),
    });

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="model-alice"]')?.click();
    });

    const nextMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    expect(nextMembers[0]).toMatchObject({
      id: 'alice',
      model: 'claude-haiku-4-5-20251001',
      effort: undefined,
    });
  });

  it('clears stale teammate effort imported through the JSON editor', async () => {
    const { host, onChange } = renderMembersEditor({
      inheritedProviderId: 'anthropic',
      inheritedEffort: 'medium',
      members: [createMemberDraft({ id: 'alice', name: 'alice' })],
      runtimeProviderStatusById: new Map([['anthropic', anthropicStatusWithHaikuWithoutEffort()]]),
    });

    await act(async () => {
      editJsonButton(host).click();
      await Promise.resolve();
    });

    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="members-json-editor"]')!;
    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      textareaValueSetter?.call(
        editor,
        JSON.stringify([
          {
            name: 'alice',
            providerId: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            effort: 'medium',
          },
        ])
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const nextMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    expect(nextMembers[0]).toMatchObject({
      name: 'alice',
      providerId: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      effort: undefined,
    });
  });
});

describe('MembersEditorSection worktree master checkbox', () => {
  it('renders indeterminate when only some active members use worktrees', () => {
    const { host } = renderMembersEditor({
      members: [
        createMemberDraft({ id: 'alice', name: 'alice' }),
        createMemberDraft({ id: 'bob', name: 'bob', isolation: 'worktree' }),
      ],
      teammateWorktreeDefault: true,
    });

    const checkbox = masterWorktreeCheckbox(host);

    expect(checkbox.checked).toBe(false);
    expect(checkbox.dataset.state).toBe('indeterminate');
  });

  it('renders checked only when all active members use worktrees', () => {
    const { host } = renderMembersEditor({
      members: [
        createMemberDraft({ id: 'alice', name: 'alice', isolation: 'worktree' }),
        createMemberDraft({ id: 'bob', name: 'bob', isolation: 'worktree' }),
      ],
    });

    const checkbox = masterWorktreeCheckbox(host);

    expect(checkbox.checked).toBe(true);
    expect(checkbox.dataset.state).toBe('checked');
  });

  it('turns all active members on when clicked from mixed state', () => {
    const { host, onChange } = renderMembersEditor({
      members: [
        createMemberDraft({ id: 'alice', name: 'alice' }),
        createMemberDraft({ id: 'bob', name: 'bob', isolation: 'worktree' }),
      ],
    });

    act(() => {
      masterWorktreeCheckbox(host).click();
    });

    const nextMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];

    expect(nextMembers.map((member) => member.isolation)).toEqual(['worktree', 'worktree']);
  });
});

function anthropicStatusWithHaikuWithoutEffort(): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    models: ['claude-haiku-4-5-20251001'],
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: '2026-07-04T00:00:00.000Z',
      staleAt: '2026-07-04T00:10:00.000Z',
      defaultModelId: 'claude-haiku-4-5-20251001',
      defaultLaunchModel: 'claude-haiku-4-5-20251001',
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
      models: [
        {
          id: 'claude-haiku-4-5-20251001',
          launchModel: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku 4.5',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'anthropic-models-api',
        },
      ],
    },
    modelAvailability: [],
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
      reasoningEffort: {
        supported: true,
        values: [],
        configPassthrough: false,
      },
    },
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
  } as CliProviderStatus;
}

describe('MembersEditorSection Agent Teams MCP master checkbox', () => {
  it('renders to the right of the worktree master control', () => {
    const { host } = renderMembersEditor({
      members: [createMemberDraft({ id: 'alice', name: 'alice' })],
    });

    const worktreeCheckbox = masterWorktreeCheckbox(host);
    const mcpCheckbox = masterAgentTeamsMcpCheckbox(host);

    expect(host.textContent).toContain('Agent Teams MCP only');
    expect(mcpCheckbox.checked).toBe(false);
    expect(
      worktreeCheckbox.compareDocumentPosition(mcpCheckbox) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('forces all active members to Agent Teams MCP when enabled', () => {
    const removed = createMemberDraft({
      id: 'removed',
      name: 'removed',
      mcpPolicy: { mode: 'strictAllowlist', serverNames: ['github'] },
      removedAt: Date.now(),
    });
    const { host, onChange } = renderMembersEditor({
      members: [
        createMemberDraft({ id: 'alice', name: 'alice' }),
        createMemberDraft({
          id: 'bob',
          name: 'bob',
          mcpPolicy: { mode: 'inheritScopes', scopes: { user: true, project: false } },
        }),
        removed,
      ],
      softDeleteMembers: true,
    });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });

    const nextMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];

    expect(nextMembers.find((member) => member.id === 'alice')?.mcpPolicy).toEqual({
      mode: 'appOnly',
    });
    expect(nextMembers.find((member) => member.id === 'bob')?.mcpPolicy).toEqual({
      mode: 'appOnly',
    });
    expect(nextMembers.find((member) => member.id === 'removed')?.mcpPolicy).toEqual(
      removed.mcpPolicy
    );
  });

  it('restores previous policies after rerender when disabled', () => {
    const originalMembers = [
      createMemberDraft({ id: 'alice', name: 'alice' }),
      createMemberDraft({
        id: 'bob',
        name: 'bob',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: true, project: false, local: true },
          serverNames: ['github', 'linear'],
        },
      }),
    ];
    const { host, onChange, rerender } = renderMembersEditor({ members: originalMembers });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });
    const lockedMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    rerender(lockedMembers);

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });

    const restoredMembers = onChange.mock.calls[1]?.[0] as MemberDraft[];

    expect(restoredMembers.find((member) => member.id === 'alice')?.mcpPolicy).toBeUndefined();
    expect(restoredMembers.find((member) => member.id === 'bob')?.mcpPolicy).toEqual(
      originalMembers[1].mcpPolicy
    );
  });

  it('gives new members Agent Teams MCP while lock is enabled, then restores them to inherited MCP', () => {
    const { host, onChange, rerender } = renderMembersEditor({
      members: [createMemberDraft({ id: 'alice', name: 'alice' })],
    });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });
    const lockedMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    rerender(lockedMembers);

    act(() => {
      addMemberButton(host).click();
    });

    const withNewMember = onChange.mock.calls[1]?.[0] as MemberDraft[];
    const addedMember = withNewMember.at(-1);
    expect(addedMember?.mcpPolicy).toEqual({ mode: 'appOnly' });

    rerender(withNewMember);
    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });

    const restoredMembers = onChange.mock.calls[2]?.[0] as MemberDraft[];
    expect(
      restoredMembers.find((member) => member.id === addedMember?.id)?.mcpPolicy
    ).toBeUndefined();
  });

  it('keeps the restore map stable when a member is removed while locked', () => {
    const originalMembers = [
      createMemberDraft({
        id: 'alice',
        name: 'alice',
        mcpPolicy: { mode: 'inheritScopes', scopes: { user: false, project: true } },
      }),
      createMemberDraft({
        id: 'bob',
        name: 'bob',
        mcpPolicy: { mode: 'strictAllowlist', serverNames: ['github'] },
      }),
    ];
    const { host, onChange, rerender } = renderMembersEditor({ members: originalMembers });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });
    const lockedMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    rerender(lockedMembers);

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="remove-bob"]')?.click();
    });
    const withoutBob = onChange.mock.calls[1]?.[0] as MemberDraft[];
    rerender(withoutBob);

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });

    const restoredMembers = onChange.mock.calls[2]?.[0] as MemberDraft[];
    expect(restoredMembers.map((member) => member.id)).toEqual(['alice']);
    expect(restoredMembers[0]?.mcpPolicy).toEqual(originalMembers[0].mcpPolicy);
  });

  it('forces JSON editor changes through Agent Teams MCP while lock is enabled', async () => {
    const { host, onChange, rerender } = renderMembersEditor({
      members: [createMemberDraft({ id: 'alice', name: 'alice' })],
    });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });
    const lockedMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    rerender(lockedMembers);

    await act(async () => {
      editJsonButton(host).click();
      await Promise.resolve();
    });

    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="members-json-editor"]')!;
    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      textareaValueSetter?.call(
        editor,
        JSON.stringify([
          {
            name: 'alice',
            role: 'developer',
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { user: true, project: true, local: true },
              serverNames: ['github'],
            },
          },
        ])
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const nextMembers = onChange.mock.calls[1]?.[0] as MemberDraft[];
    expect(nextMembers).toHaveLength(1);
    expect(nextMembers[0]?.mcpPolicy).toEqual({ mode: 'appOnly' });
  });

  it('restores a soft-deleted member policy when that member is restored while locked', () => {
    const originalMembers = [
      createMemberDraft({
        id: 'alice',
        name: 'alice',
        mcpPolicy: { mode: 'inheritScopes', scopes: { user: true, project: false } },
      }),
      createMemberDraft({
        id: 'bob',
        name: 'bob',
        mcpPolicy: { mode: 'strictAllowlist', serverNames: ['github'] },
        removedAt: Date.now(),
      }),
    ];
    const { host, onChange, rerender } = renderMembersEditor({
      members: originalMembers,
      softDeleteMembers: true,
    });

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });
    const lockedMembers = onChange.mock.calls[0]?.[0] as MemberDraft[];
    rerender(lockedMembers);

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="restore-bob"]')?.click();
    });
    const restoredDuringLock = onChange.mock.calls[1]?.[0] as MemberDraft[];
    expect(restoredDuringLock.find((member) => member.id === 'bob')?.mcpPolicy).toEqual({
      mode: 'appOnly',
    });
    rerender(restoredDuringLock);

    act(() => {
      masterAgentTeamsMcpCheckbox(host).click();
    });

    const restoredAfterUnlock = onChange.mock.calls[2]?.[0] as MemberDraft[];
    expect(restoredAfterUnlock.find((member) => member.id === 'alice')?.mcpPolicy).toEqual(
      originalMembers[0].mcpPolicy
    );
    expect(restoredAfterUnlock.find((member) => member.id === 'bob')?.mcpPolicy).toEqual(
      originalMembers[1].mcpPolicy
    );
  });
});
