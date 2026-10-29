import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { HostTeamOperationError } from '@features/agent-backend/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    gatewayProvider: {
      listGatewayBindings: vi.fn(async () => []),
      unbindGatewayMember: vi.fn(async () => {}),
    },
    teams: {
      getSavedRequest: vi.fn(),
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
              onChange([
                {
                  ...members[0],
                  ...(field === 'role'
                    ? { roleSelection: 'Developer' }
                    : { model: 'edited/model' }),
                },
                ...members.slice(1),
              ]),
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

import { api } from '@renderer/api';
import { EditTeamDialog } from '@renderer/components/team/dialogs/EditTeamDialog';

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

  async function setup(teamName = 'sandbox-team', strict = false) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const members = sourceMembers();
    const render = async (currentMembers = members, open = true) => {
      await act(() => {
        const dialog = React.createElement(EditTeamDialog, {
          open,
          teamName,
          currentName: 'Sandbox',
          currentDescription: '',
          currentColor: 'blue',
          currentMembers,
          onClose,
          onSaved: vi.fn(),
          onChangeLeadRuntime: vi.fn(),
          isTeamAlive: false,
          leadMember: { name: 'team-lead', providerId: 'opencode' } as ResolvedTeamMember,
        });
        root.render(strict ? React.createElement(React.StrictMode, null, dialog) : dialog);
        return Promise.resolve();
      });
    };
    const click = async (text: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent === text
      );
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

  function hostSource() {
    return {
      teamName: 'host-team:TEST-edit-owner',
      savedSettingsFingerprint: 'a'.repeat(64),
      displayName: 'Sandbox',
      description: '',
      color: 'blue',
      cwd: '/TEST-workspace',
      prompt: 'TEST retained prompt',
      skipPermissions: false,
      limitContext: false,
      members: [
        { name: 'other', role: 'Reviewer' },
        { name: 'zai-one', providerId: 'opencode' as const, model: 'zai-coding-plan/glm-5.3' },
        { name: 'inherited' },
        {
          name: 'legacy',
          providerId: 'opencode' as const,
          model: 'legacy/model',
          effort: 'high' as const,
        },
      ],
    };
  }

  it('saves Host settings and edited roles through one original-revision roster CAS without legacy mutations', async () => {
    const saved = hostSource();
    vi.mocked(api.teams.getSavedRequest).mockResolvedValue(saved);
    const { root, click } = await setup(saved.teamName, true);
    try {
      await click('change-member-role');
      await click('Save');
      expect(api.teams.getSavedRequest).toHaveBeenCalledOnce();
      expect(api.teams.replaceMembers).toHaveBeenCalledOnce();
      const [target, payload] = vi.mocked(api.teams.replaceMembers).mock.calls[0];
      expect(target).toBe(saved.teamName);
      expect(payload.configuration).toMatchObject({
        expectedRevision: saved.savedSettingsFingerprint,
        savedSettings: {
          cwd: saved.cwd,
          prompt: saved.prompt,
          skipPermissions: false,
          limitContext: false,
          displayName: 'Sandbox',
          description: '',
          color: 'blue',
        },
      });
      expect(payload.members[0]).toMatchObject({ name: 'other', role: 'Developer' });
      expect(payload.members[1].model).toBe('zai-coding-plan/glm-5.3');
      expect(payload.members[2]).toEqual({ name: 'inherited', role: undefined });
      expect(payload.command?.commandId).toBe(payload.command?.idempotencyKey);
      expect(payload.command?.commandId).toBeTruthy();
      expect(api.teams.updateConfig).not.toHaveBeenCalled();
      expect(api.teams.removeMember).not.toHaveBeenCalled();
      expect(api.teams.restartMember).not.toHaveBeenCalled();
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('retains the original Host save command after response loss and refuses a replacement payload', async () => {
    const saved = hostSource();
    vi.mocked(api.teams.getSavedRequest).mockResolvedValue(saved);
    vi.mocked(api.teams.replaceMembers).mockRejectedValueOnce(new Error('TEST outcome unknown'));
    const { root, click, host } = await setup(saved.teamName);
    try {
      await click('change-member-role');
      await click('Save');
      const first = vi.mocked(api.teams.replaceMembers).mock.calls[0][1];
      await click('Save');
      expect(vi.mocked(api.teams.replaceMembers).mock.calls[1][1]).toEqual(first);
      expect(api.teams.getSavedRequest).toHaveBeenCalledOnce();
      await click('change-member-runtime');
      await click('Save');
      expect(api.teams.replaceMembers).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('Retry its original settings');
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('does not silently refresh an open Host form to a later owner revision', async () => {
    const saved = hostSource();
    vi.mocked(api.teams.getSavedRequest)
      .mockResolvedValueOnce(saved)
      .mockResolvedValue({ ...saved, savedSettingsFingerprint: 'b'.repeat(64) });
    vi.mocked(api.teams.replaceMembers).mockRejectedValueOnce(new Error('TEST stale revision'));
    const { root, click } = await setup(saved.teamName);
    try {
      await click('Save');
      expect(api.teams.getSavedRequest).toHaveBeenCalledOnce();
      expect(
        vi.mocked(api.teams.replaceMembers).mock.calls[0][1].configuration?.expectedRevision
      ).toBe(saved.savedSettingsFingerprint);
      expect(api.teams.updateConfig).not.toHaveBeenCalled();
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('allows correction after a typed pre-admission refusal while preserving the source revision', async () => {
    const saved = hostSource();
    vi.mocked(api.teams.getSavedRequest).mockResolvedValue(saved);
    vi.mocked(api.teams.replaceMembers).mockRejectedValueOnce(
      new HostTeamOperationError('invalid', 'rejected')
    );
    const { root, click } = await setup(saved.teamName);
    try {
      await click('Save');
      const first = vi.mocked(api.teams.replaceMembers).mock.calls[0][1];
      await click('change-member-role');
      await click('Save');
      const corrected = vi.mocked(api.teams.replaceMembers).mock.calls[1][1];
      expect(corrected.command?.commandId).not.toBe(first.command?.commandId);
      expect(corrected.configuration?.expectedRevision).toBe(saved.savedSettingsFingerprint);
      expect(corrected.members[0].role).toBe('Developer');
      expect(api.teams.getSavedRequest).toHaveBeenCalledOnce();
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('rejects a mismatched Host source without replacing its roster or changing the typed draft', async () => {
    const saved = hostSource();
    vi.mocked(api.teams.getSavedRequest).mockResolvedValue({
      ...saved,
      members: saved.members.map((member) => ({ ...member, role: 'Newer role' })),
    });
    const { root, click, host } = await setup(saved.teamName);
    try {
      await click('change-member-runtime');
      await click('Save');
      expect(api.teams.replaceMembers).not.toHaveBeenCalled();
      expect(api.teams.updateConfig).not.toHaveBeenCalled();
      expect(readDrafts(host)[0].model).toBe('edited/model');
      expect(host.textContent).toContain('saved team configuration changed');
    } finally {
      await act(() => Promise.resolve(root.unmount()));
    }
  });

  it('keeps edits made during Host hydration and never dispatches after the dialog unmounts', async () => {
    const saved = hostSource();
    let resolve!: (value: typeof saved) => void;
    vi.mocked(api.teams.getSavedRequest).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { root, click, host } = await setup(saved.teamName);
    await click('change-member-runtime');
    expect(readDrafts(host)[0].model).toBe('edited/model');
    await click('Save');
    await act(() => Promise.resolve(root.unmount()));
    await act(async () => {
      resolve(saved);
      await Promise.resolve();
    });
    expect(api.teams.replaceMembers).not.toHaveBeenCalled();
    expect(api.teams.updateConfig).not.toHaveBeenCalled();
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
