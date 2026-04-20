import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      updateConfig: vi.fn(async () => {}),
      replaceMembers: vi.fn(async () => {}),
      removeMember: vi.fn(async () => {}),
      restartMember: vi.fn(async () => {}),
    },
  },
}));

vi.mock('@renderer/components/team/members/MembersEditorSection', () => ({
  MembersEditorSection: ({
    members,
    onChange,
    fieldError,
    headerExtra,
  }: {
    members: Array<{
      id: string;
      name: string;
      originalName?: string;
      roleSelection?: string;
      customRole?: string;
      providerId?: string;
      model?: string;
      effort?: string;
    }>;
    onChange: (
      members: Array<{
        id: string;
        name: string;
        originalName?: string;
        roleSelection?: string;
        customRole?: string;
        providerId?: string;
        model?: string;
        effort?: string;
      }>
    ) => void;
    fieldError?: string;
    headerExtra?: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      null,
      'members-editor',
      headerExtra,
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'rename-existing-member',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 0 ? { ...member, name: 'alice-renamed' } : member
              )
            ),
        },
        'rename-existing-member'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'remove-existing-member',
          onClick: () => onChange(members.slice(1)),
        },
        'remove-existing-member'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'duplicate-member-name',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 1 ? { ...member, name: members[0]?.name ?? member.name } : member
              )
            ),
        },
        'duplicate-member-name'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'invalid-member-name',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 0 ? { ...member, name: 'team-lead' } : member
              )
            ),
        },
        'invalid-member-name'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'change-member-runtime',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 0 ? { ...member, providerId: 'codex', model: 'gpt-5.4' } : member
              )
            ),
        },
        'change-member-runtime'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'revert-member-runtime',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 0 ? { ...member, providerId: 'codex', model: 'gpt-5.2' } : member
              )
            ),
        },
        'revert-member-runtime'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'change-member-role',
          onClick: () =>
            onChange(
              members.map((member, index) =>
                index === 0 ? { ...member, roleSelection: 'developer' } : member
              )
            ),
        },
        'change-member-role'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'add-new-member',
          onClick: () =>
            onChange([
              ...members,
              {
                id: 'draft-new',
                name: 'charlie',
                roleSelection: '',
                customRole: '',
              },
            ]),
        },
        'add-new-member'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'remove-new-member',
          onClick: () => onChange(members.filter((member) => member.id !== 'draft-new')),
        },
        'remove-new-member'
      ),
      fieldError ? React.createElement('div', { 'data-testid': 'members-field-error' }, fieldError) : null
    ),
  buildMembersFromDrafts: vi.fn((members) =>
    (
      members as Array<{
        name: string;
        roleSelection?: string;
        customRole?: string;
        providerId?: string;
        model?: string;
        effort?: string;
      }>
    ).map((member) => ({
      name: member.name,
      role:
        member.roleSelection === 'developer'
          ? 'Developer'
          : member.roleSelection === 'reviewer'
            ? 'Reviewer'
            : member.customRole || undefined,
      providerId: member.providerId,
      model: member.model,
      effort: member.effort,
    }))
  ),
  createMemberDraftsFromInputs: vi.fn((members) =>
    (
      members as Array<{
        name: string;
        role?: string;
        providerId?: string;
        model?: string;
        effort?: string;
      }>
    ).map((member, index) => ({
      id: `draft-${index}`,
      name: member.name,
      originalName: member.name,
      roleSelection:
        member.role === 'Developer'
          ? 'developer'
          : member.role === 'Reviewer'
            ? 'reviewer'
            : member.role
              ? '__custom__'
              : '',
      customRole:
        member.role && member.role !== 'Developer' && member.role !== 'Reviewer' ? member.role : '',
      providerId: member.providerId,
      model: member.model,
      effort: member.effort,
    }))
  ),
  createMemberDraft: vi.fn((member) => member),
  filterEditableMemberInputs: vi.fn((members) => members),
  validateMemberNameInline: vi.fn(() => null),
}));

vi.mock('@renderer/components/team/members/MemberDraftRow', () => ({
  MemberDraftRow: ({
    member,
    lockedRoleLabel,
    lockedModelAction,
  }: {
    member: { name: string };
    lockedRoleLabel?: string;
    lockedModelAction?: {
      label: string;
      onClick: () => void;
    };
  }) =>
    React.createElement(
      'div',
      null,
      member.name,
      lockedRoleLabel ? ` ${lockedRoleLabel}` : '',
      lockedModelAction
        ? React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'lead-runtime-action',
              onClick: lockedModelAction.onClick,
            },
            lockedModelAction.label
          )
        : null
    ),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
  }) => React.createElement('button', { type: type ?? 'button', onClick, disabled }, children),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? React.createElement('div', null, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/hooks/useFileListCacheWarmer', () => ({
  useFileListCacheWarmer: () => {},
}));

vi.mock('@renderer/constants/teamColors', () => ({
  getTeamColorSet: () => ({ border: '#22c55e' }),
  getThemedBadge: () => '#0f172a',
}));

import { EditTeamDialog } from '@renderer/components/team/dialogs/EditTeamDialog';
import { api } from '@renderer/api';

describe('EditTeamDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not reset unsaved edits when live team props refresh while the dialog stays open', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = (currentMembers: Array<{ name: string; role?: string }>) =>
      React.createElement(EditTeamDialog, {
        open: true,
        teamName: 'live-team',
        currentName: 'Current Team',
        currentDescription: 'desc',
        currentColor: 'blue',
        currentMembers: currentMembers as any,
        isTeamAlive: true,
        projectPath: '/tmp/project',
        onClose: vi.fn(),
        onChangeLeadRuntime: vi.fn(),
        onSaved: vi.fn(),
      });

    await act(async () => {
      root.render(renderDialog([{ name: 'alice', role: 'Reviewer' }]));
      await Promise.resolve();
    });

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    if (!nameInput) {
      throw new Error('Expected team name input to exist');
    }

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, 'Unsaved Team Name');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(nameInput.value).toBe('Unsaved Team Name');

    await act(async () => {
      root.render(renderDialog([{ name: 'alice', role: 'Developer' }]));
      await Promise.resolve();
    });

    const updatedNameInput = host.querySelector('#edit-team-name') as HTMLInputElement | null;
    expect(updatedNameInput?.value).toBe('Unsaved Team Name');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the team lead in the members section as read-only context', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          leadMember: {
            name: 'team-lead',
            role: 'Team Lead',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
          } as any,
          resolvedMemberColorMap: new Map([
            ['team-lead', 'forest'],
            ['alice', 'blue'],
          ]),
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('lead');
    expect(host.textContent).toContain('Team Lead');
    expect(host.textContent).toContain(
      'Team lead name and role stay read-only here. Open the runtime panel on the lead row to change provider, model, or effort.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving live roster edits that rename existing teammates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [
            { name: 'alice', role: 'Reviewer' },
            { name: 'bob', role: 'Developer' },
          ] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const renameButton = host.querySelector('[data-testid=\"rename-existing-member\"]');
    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    expect(renameButton).not.toBeNull();
    expect(saveButton).not.toBeNull();

    await act(async () => {
      renameButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.updateConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Live save is blocked because existing teammates were renamed.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('removes existing live teammates through the dedicated removeMember path during save', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.removeMember).mockResolvedValue(undefined);
    vi.mocked(api.teams.replaceMembers).mockResolvedValue(undefined);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [
            { name: 'alice', role: 'Reviewer' },
            { name: 'bob', role: 'Developer' },
          ] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      host
        .querySelector('[data-testid="remove-existing-member"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.updateConfig).toHaveBeenCalledTimes(1);
    expect(api.teams.removeMember).toHaveBeenCalledWith('live-team', 'alice');
    expect(api.teams.replaceMembers).toHaveBeenCalledWith('live-team', {
      members: [{ name: 'bob', role: 'Developer', providerId: undefined, model: undefined, effort: undefined }],
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks adding a new teammate from Edit Team while the team is live', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const addButton = host.querySelector('[data-testid="add-new-member"]');
    const saveButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save');

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.updateConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'New teammates cannot be added from Edit Team while the team is live. Use the Add member dialog instead.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving while team provisioning is still in progress', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          isTeamAlive: false,
          isTeamProvisioning: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Team provisioning is still in progress. Editing is temporarily locked until launch finishes.'
    );

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    ) as HTMLButtonElement | undefined;
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('restarts an existing live teammate when role changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.replaceMembers).mockResolvedValue(undefined);
    vi.mocked(api.teams.restartMember).mockResolvedValue(undefined);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      host
        .querySelector('[data-testid="change-member-role"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.restartMember).toHaveBeenCalledWith('live-team', 'alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving when member names are duplicated', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [
            { name: 'alice', role: 'Reviewer' },
            { name: 'bob', role: 'Developer' },
          ] as any,
          isTeamAlive: false,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const duplicateButton = host.querySelector('[data-testid=\"duplicate-member-name\"]');
    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    await act(async () => {
      duplicateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect((saveButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect(api.teams.updateConfig).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears stale validation feedback after the user edits the form', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const addButton = host.querySelector('[data-testid="add-new-member"]');
    const removeButton = host.querySelector('[data-testid="remove-new-member"]');
    const saveButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save');

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'New teammates cannot be added from Edit Team while the team is live. Use the Add member dialog instead.'
    );

    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain(
      'New teammates cannot be added from Edit Team while the team is live. Use the Add member dialog instead.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('surfaces partial-save feedback when team settings save but member changes fail', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.replaceMembers).mockRejectedValueOnce(new Error('disk write failed'));
    const onSaved = vi.fn();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved,
        })
      );
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Team settings were saved, but member changes failed: disk write failed'
    );
    expect(onSaved).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('allows retrying save after config-only partial save once refreshed settings props catch up', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.replaceMembers)
      .mockRejectedValueOnce(new Error('disk write failed'))
      .mockResolvedValueOnce(undefined);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = (currentName: string) =>
      React.createElement(EditTeamDialog, {
        open: true,
        teamName: 'live-team',
        currentName,
        currentDescription: 'desc',
        currentColor: 'blue',
        currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
        isTeamAlive: true,
        projectPath: '/tmp/project',
        onClose: vi.fn(),
        onChangeLeadRuntime: vi.fn(),
        onSaved: vi.fn(),
      });

    await act(async () => {
      root.render(renderDialog('Current Team'));
      await Promise.resolve();
    });

    const nameInput = host.querySelector('#edit-team-name') as HTMLInputElement | null;
    const saveButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, 'Renamed Team');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Team settings were saved, but member changes failed: disk write failed'
    );

    await act(async () => {
      root.render(renderDialog('Renamed Team'));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain(
      'Team settings changed while this dialog was open. Reopen it and review the latest state before saving.'
    );
    expect(api.teams.updateConfig).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving when a teammate name is reserved', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [
            { name: 'alice', role: 'Reviewer' },
            { name: 'bob', role: 'Developer' },
          ] as any,
          isTeamAlive: false,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const invalidButton = host.querySelector('[data-testid=\"invalid-member-name\"]');
    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    await act(async () => {
      invalidButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect((saveButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="members-field-error"]')?.textContent).toContain(
      'Member name "team-lead" is reserved'
    );
    expect(api.teams.updateConfig).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks saving when editable team source data changed while the dialog stayed open', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderDialog = (role: string) =>
      React.createElement(EditTeamDialog, {
        open: true,
        teamName: 'live-team',
        currentName: 'Current Team',
        currentDescription: 'desc',
        currentColor: 'blue',
        currentMembers: [{ name: 'alice', role }] as any,
        isTeamAlive: true,
        projectPath: '/tmp/project',
        onClose: vi.fn(),
        onChangeLeadRuntime: vi.fn(),
        onSaved: vi.fn(),
      });

    await act(async () => {
      root.render(renderDialog('Reviewer'));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(renderDialog('Developer'));
      await Promise.resolve();
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    );

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.updateConfig).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Team settings changed while this dialog was open. Reopen it and review the latest state before saving.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('allows retrying save after restart failures before props catch up to the committed state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.replaceMembers).mockResolvedValue(undefined);
    vi.mocked(api.teams.restartMember)
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSaved = vi.fn();

    const renderDialog = (role: string) =>
      React.createElement(EditTeamDialog, {
        open: true,
        teamName: 'live-team',
        currentName: 'Current Team',
        currentDescription: 'desc',
        currentColor: 'blue',
        currentMembers: [{ name: 'alice', role, providerId: 'codex', model: 'gpt-5.2' }] as any,
        isTeamAlive: true,
        projectPath: '/tmp/project',
        onClose: vi.fn(),
        onChangeLeadRuntime: vi.fn(),
        onSaved,
      });

    await act(async () => {
      root.render(renderDialog('Reviewer'));
      await Promise.resolve();
    });

    const saveButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save');

    await act(async () => {
      host
        .querySelector('[data-testid="change-member-runtime"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.restartMember).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer', providerId: 'codex', model: 'gpt-5.4' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain(
      'Team settings changed while this dialog was open. Reopen it and review the latest state before saving.'
    );
    expect(api.teams.updateConfig).toHaveBeenCalledTimes(2);
    expect(api.teams.restartMember).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('drops pending restart retry when the member runtime is changed away from the failed target', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(api.teams.updateConfig).mockResolvedValue({} as any);
    vi.mocked(api.teams.replaceMembers).mockResolvedValue(undefined);
    vi.mocked(api.teams.restartMember).mockRejectedValueOnce(new Error('restart failed'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'live-team',
          currentName: 'Current Team',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer', providerId: 'codex', model: 'gpt-5.2' }] as any,
          isTeamAlive: true,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const saveButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save');

    await act(async () => {
      host
        .querySelector('[data-testid="change-member-runtime"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.restartMember).toHaveBeenCalledTimes(1);

    await act(async () => {
      host
        .querySelector('[data-testid="revert-member-runtime"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.teams.restartMember).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows an inline lead runtime action inside the lead context row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const onChangeLeadRuntime = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(EditTeamDialog, {
          open: true,
          teamName: 'team-alpha',
          currentName: 'Team Alpha',
          currentDescription: 'desc',
          currentColor: 'blue',
          currentMembers: [{ name: 'alice', role: 'Reviewer' }] as any,
          leadMember: {
            name: 'lead',
            role: 'Team Lead',
            providerId: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
          } as any,
          projectPath: '/tmp/project',
          onClose: vi.fn(),
          onChangeLeadRuntime,
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[data-testid="lead-runtime-action"]');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onChangeLeadRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
