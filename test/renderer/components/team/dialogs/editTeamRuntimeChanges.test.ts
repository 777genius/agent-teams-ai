import { describe, expect, it } from 'vitest';

import {
  buildEditTeamMemberRosterSnapshot,
  buildEditTeamSourceSnapshot,
  getLiveRosterIdentityChanges,
  getMembersRequiringRuntimeRestart,
} from '@renderer/components/team/dialogs/editTeamRuntimeChanges';

describe('getMembersRequiringRuntimeRestart', () => {
  it('returns existing teammates whose role, workflow, provider, model, or effort changed', () => {
    const result = getMembersRequiringRuntimeRestart({
      previousMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
          workflow: 'Review PRs',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        } as any,
        {
          name: 'bob',
          role: 'Developer',
          workflow: 'Ship features',
          providerId: 'anthropic',
          model: '',
          effort: 'low',
        } as any,
      ],
      nextMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
          workflow: 'Review PRs',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
        },
        {
          name: 'bob',
          role: 'Developer',
          workflow: 'Ship safer features',
          providerId: 'anthropic',
          model: '',
          effort: 'high',
        },
      ],
    });

    expect(result).toEqual(['alice', 'bob']);
  });

  it('ignores newly added or renamed teammates for restart targeting', () => {
    const result = getMembersRequiringRuntimeRestart({
      previousMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
          workflow: 'Review PRs',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'medium',
        } as any,
      ],
      nextMembers: [
        {
          name: 'alice-2',
          role: 'Reviewer',
          workflow: 'Review PRs',
          providerId: 'codex',
          model: 'gpt-5.4',
          effort: 'high',
        },
        {
          name: 'bob',
          role: 'Developer',
          workflow: 'Ship features',
          providerId: 'anthropic',
          model: '',
          effort: undefined,
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it('treats empty values as unchanged normalized runtime settings', () => {
    const result = getMembersRequiringRuntimeRestart({
      previousMembers: [
        {
          name: 'alice',
          role: undefined,
          workflow: undefined,
          providerId: undefined,
          model: undefined,
          effort: undefined,
        } as any,
      ],
      nextMembers: [
        {
          name: 'alice',
          role: '',
          workflow: '',
          providerId: undefined,
          model: '',
          effort: undefined,
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it('returns existing teammates whose worktree isolation changed', () => {
    const result = getMembersRequiringRuntimeRestart({
      previousMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
          isolation: undefined,
        } as any,
        {
          name: 'bob',
          role: 'Developer',
          isolation: 'worktree',
        } as any,
      ],
      nextMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
          isolation: 'worktree',
        },
        {
          name: 'bob',
          role: 'Developer',
        },
      ],
    });

    expect(result).toEqual(['alice', 'bob']);
  });

  it('reports live rename and remove of existing teammates separately from runtime restarts', () => {
    const result = getLiveRosterIdentityChanges({
      previousMembers: [
        {
          name: 'alice',
          role: 'Reviewer',
        } as any,
        {
          name: 'bob',
          role: 'Developer',
        } as any,
      ],
      nextDrafts: [
        {
          id: 'draft-alice',
          name: 'alice-renamed',
          originalName: 'alice',
          roleSelection: '',
          customRole: '',
        },
      ] as any,
    });

    expect(result).toEqual({
      renamed: ['alice'],
      removed: ['bob'],
    });
  });

  it('ignores live status-only member refreshes in the edit source snapshot', () => {
    const base = buildEditTeamSourceSnapshot({
      name: 'Team A',
      description: 'desc',
      color: 'blue',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          status: 'online',
          branch: 'main',
        } as any,
      ],
    });

    const refreshed = buildEditTeamSourceSnapshot({
      name: 'Team A',
      description: 'desc',
      color: 'blue',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          status: 'offline',
          branch: 'feature/x',
        } as any,
      ],
    });

    expect(refreshed).toBe(base);
  });

  it('matches equivalent current and built roster snapshots', () => {
    const current = buildEditTeamMemberRosterSnapshot([
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'codex',
        providerBackendId: 'api',
        model: 'gpt-5.4-mini',
        effort: 'medium',
        status: 'online',
      } as any,
    ]);

    const built = buildEditTeamMemberRosterSnapshot([
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ]);

    expect(built).toBe(current);
  });

  it('keeps provider backend and fast mode in the edit roster snapshot', () => {
    const base = buildEditTeamMemberRosterSnapshot([
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        fastMode: 'inherit',
      } as any,
    ]);

    const changed = buildEditTeamMemberRosterSnapshot([
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4-mini',
        fastMode: 'off',
      } as any,
    ]);

    expect(changed).not.toBe(base);
  });

  it('keeps worktree isolation in the edit source snapshot', () => {
    const sharedWorkspace = buildEditTeamSourceSnapshot({
      name: 'Team A',
      description: 'desc',
      color: 'blue',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
        } as any,
      ],
    });

    const isolatedWorkspace = buildEditTeamSourceSnapshot({
      name: 'Team A',
      description: 'desc',
      color: 'blue',
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          isolation: 'worktree',
        } as any,
      ],
    });

    expect(isolatedWorkspace).not.toBe(sharedWorkspace);
    expect(JSON.parse(isolatedWorkspace).members[0]).toMatchObject({
      isolation: 'worktree',
    });
  });
});
