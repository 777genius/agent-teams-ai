import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      updateConfig: vi.fn(() => Promise.resolve()),
      replaceMembers: vi.fn(() => Promise.resolve()),
      removeMember: vi.fn(() => Promise.resolve()),
      restartMember: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock('@renderer/components/team/members/MembersEditorSection', async () => ({
  MembersEditorSection: ({
    members,
    onChange,
  }: {
    members: import('@renderer/components/team/members/membersEditorTypes').MemberDraft[];
    onChange: (
      members: import('@renderer/components/team/members/membersEditorTypes').MemberDraft[]
    ) => void;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('pre', { 'data-testid': 'drafts' }, JSON.stringify(members)),
      ...(['role', 'runtime'] as const).map((field) =>
        React.createElement(
          'button',
          {
            key: field,
            onClick: () =>
              onChange(
                [
                  {
                    ...members[0],
                    ...(field === 'role' ? { roleSelection: 'Developer' } : { model: 'edited/model' }),
                  },
                  ...members.slice(1),
                ]
              ),
          },
          `change-member-${field}`
        )
      )
    ),
  ...(await vi.importActual<typeof import('@renderer/components/team/members/membersEditorUtils')>(
    '@renderer/components/team/members/membersEditorUtils'
  )),
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
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
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
  useFileListCacheWarmer: () => undefined,
}));

vi.mock('@renderer/constants/teamColors', () => ({
  getTeamColorSet: () => ({ border: '#22c55e' }),
  getThemedBadge: () => '#0f172a',
}));

import { EditTeamDialog } from '@renderer/components/team/dialogs/EditTeamDialog';
import { api } from '@renderer/api';

import type { ResolvedTeamMember } from '@shared/types';

const sourceMembers = () =>
  [
    { name: 'other', role: 'Reviewer' },
    {
      name: 'zai-one',
      providerId: 'opencode',
      model: 'zai-coding-plan/glm-5.2',
      configuredRuntimeSettings: { providerId: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    },
    {
      name: 'inherited',
      providerId: 'codex',
      model: 'gpt-5.2',
      effort: 'high',
      providerBackendId: 'codex-native',
      selectedFastMode: 'on',
      configuredRuntimeSettings: {},
    },
    { name: 'legacy', providerId: 'opencode', model: 'legacy/model', effort: 'high' },
  ] as ResolvedTeamMember[];

function readDrafts(host: HTMLElement) {
  const text = host.querySelector('[data-testid="drafts"]')?.textContent;
  if (typeof text !== 'string') throw new Error('Expected rendered drafts');
  return JSON.parse(text);
}

describe('EditTeamDialog canonical settings', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const members = sourceMembers();
    const render = async (currentMembers = members, open = true) => {
      await act(() => {
        root.render(
          React.createElement(EditTeamDialog, {
            open,
            teamName: 'sandbox-team',
            currentName: 'Sandbox',
            currentDescription: '',
            currentColor: 'blue',
            currentMembers,
            onClose,
            onSaved: vi.fn(),
            onChangeLeadRuntime: vi.fn(),
            isTeamAlive: false,
            leadMember: { name: 'team-lead', providerId: 'opencode' } as ResolvedTeamMember,
          })
        );
        return Promise.resolve();
      });
    };
    const click = async (text: string) => {
      const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
      expect(button).toBeTruthy();
      await act(() => Promise.resolve(button!.click()));
    };
    await render();
    return { host, root, render, click, members, onClose };
  }

  it('shows canonical 5.3, inherited blanks and legacy fallback without changing effective display data', async () => {
    const { host, root, members } = await setup();
    try {
      const drafts = readDrafts(host);
      expect(drafts[1].model).toBe('zai-coding-plan/glm-5.3');
      expect(drafts[2]).toMatchObject({ model: '' });
      for (const key of ['providerId', 'effort', 'providerBackendId', 'fastMode']) {
        expect(drafts[2][key]).toBeUndefined();
      }
      expect(drafts[3]).toMatchObject({
        providerId: 'opencode',
        model: 'legacy/model',
        effort: 'high',
      });
      expect(members[1].model).toBe('zai-coding-plan/glm-5.2');
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('saving another member role preserves canonical and inherited settings in the actual replace payload', async () => {
    const { root, click } = await setup();
    try {
      await click('change-member-role');
      await click('Save');
      expect(api.teams.replaceMembers).toHaveBeenCalledOnce();
      const payload = vi.mocked(api.teams.replaceMembers).mock.calls[0][1];
      expect(payload.members[0]).toMatchObject({ name: 'other', role: 'Developer' });
      expect(payload.members[1]).toMatchObject({ model: 'zai-coding-plan/glm-5.3' });
      expect(payload.members[2]).toEqual({ name: 'inherited', role: undefined });
      expect(payload.members[3]).toMatchObject({ model: 'legacy/model' });
      expect(api.teams.updateConfig).toHaveBeenCalledWith('sandbox-team', {
        name: 'Sandbox',
        description: '',
        color: 'blue',
      });
      expect(api.teams.restartMember).not.toHaveBeenCalled();
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('does not replace unchanged canonical roster for a settings-only save', async () => {
    const { root, click } = await setup();
    try {
      await click('Save');
      expect(api.teams.updateConfig).toHaveBeenCalledOnce();
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('Cancel discards edits without persistence and reopening restores canonical settings', async () => {
    const { root, host, click, render, members, onClose } = await setup();
    try {
      await click('change-member-runtime');
      await click('Cancel');
      expect(onClose).toHaveBeenCalledOnce();
      expect(api.teams.updateConfig).not.toHaveBeenCalled();
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      await render(members, false);
      await render();
      const drafts = readDrafts(host);
      expect(drafts[0].model).toBe('');
      expect(drafts[1].model).toBe('zai-coding-plan/glm-5.3');
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it.each(['canonical', 'effective'] as const)(
    'handles %s source changes while a draft is open',
    async (change) => {
      const { root, host, click, render, members } = await setup();
      try {
        await click('change-member-role');
        const refreshed = members.map((member) =>
          member.name !== 'zai-one'
            ? member
            : {
                ...member,
                ...(change === 'canonical'
                  ? {
                      configuredRuntimeSettings: {
                        providerId: 'opencode' as const,
                        model: 'new/canonical',
                      },
                    }
                  : { model: 'new/effective' }),
              }
        );
        await render(refreshed);
        await click('Save');
        if (change === 'canonical') {
          expect(api.teams.updateConfig).not.toHaveBeenCalled();
          expect(api.teams.replaceMembers).not.toHaveBeenCalled();
          expect(host.textContent).toContain('Team settings changed while this dialog was open');
        } else {
          expect(api.teams.replaceMembers).toHaveBeenCalledOnce();
          expect(vi.mocked(api.teams.replaceMembers).mock.calls[0][1].members[1].model).toBe(
            'zai-coding-plan/glm-5.3'
          );
        }
      } finally {
        await act(() => Promise.resolve(root.unmount()));
      }
    }
  );
});
