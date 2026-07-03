import { describe, expect, it, vi } from 'vitest';

import {
  resolveLaunchExpectedMembers,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from '../TeamProvisioningLaunchExpectedMembers';

import type { TeamMember } from '@shared/types';

function makePorts(
  overrides: Partial<TeamProvisioningLaunchExpectedMembersPorts> = {}
): TeamProvisioningLaunchExpectedMembersPorts {
  return {
    readLaunchState: vi.fn<(teamName: string) => Promise<unknown>>(async () => null),
    readBootstrapLaunchSnapshot: vi.fn<(teamName: string) => Promise<unknown>>(async () => null),
    getMembers: vi.fn<(teamName: string) => Promise<TeamMember[]>>(async () => []),
    listInboxNames: vi.fn<(teamName: string) => Promise<string[]>>(async () => []),
    warn: vi.fn<(message: string) => void>(),
    ...overrides,
  };
}

describe('team provisioning launch expected members', () => {
  it('prefers members.meta and ignores read-only probe failures', async () => {
    const readLaunchState = vi.fn<(teamName: string) => Promise<unknown>>(async () => {
      throw new Error('launch-state unavailable');
    });
    const readBootstrapLaunchSnapshot = vi.fn<(teamName: string) => Promise<unknown>>(
      async () => {
        throw new Error('bootstrap-state unavailable');
      }
    );
    const ports = makePorts({
      readLaunchState,
      readBootstrapLaunchSnapshot,
      getMembers: vi.fn<(teamName: string) => Promise<TeamMember[]>>(async () => [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'Alice', role: 'Engineer', model: 'claude-sonnet-4-20250514' },
      ]),
      listInboxNames: vi.fn<(teamName: string) => Promise<string[]>>(async () => ['Bob']),
    });

    const result = await resolveLaunchExpectedMembers(
      {
        teamName: 'team-a',
        configRaw: JSON.stringify({ members: [{ name: 'Bob' }] }),
      },
      ports
    );

    expect(readLaunchState).toHaveBeenCalledWith('team-a');
    expect(readBootstrapLaunchSnapshot).toHaveBeenCalledWith('team-a');
    expect(result).toEqual({
      source: 'members-meta',
      members: [{ name: 'Alice', role: 'Engineer', model: 'claude-sonnet-4-20250514' }],
    });
  });

  it('falls back to inbox names and merges config metadata by name', async () => {
    const ports = makePorts({
      listInboxNames: vi.fn<(teamName: string) => Promise<string[]>>(async () => [
        'team-lead',
        'Bob',
        'user',
      ]),
    });

    const result = await resolveLaunchExpectedMembers(
      {
        teamName: 'team-a',
        configRaw: JSON.stringify({
          members: [{ name: 'Bob', role: 'Reviewer', workflow: 'Check diffs' }],
        }),
      },
      ports
    );

    expect(result).toEqual({
      source: 'inboxes',
      members: [{ name: 'Bob', role: 'Reviewer', workflow: 'Check diffs' }],
    });
  });

  it('falls back to config members when members.meta and inboxes are empty', async () => {
    const result = await resolveLaunchExpectedMembers(
      {
        teamName: 'team-a',
        configRaw: JSON.stringify({
          members: [{ name: 'Alice', role: 'Builder', isolation: 'worktree' }],
        }),
      },
      makePorts()
    );

    expect(result).toEqual({
      source: 'config-fallback',
      members: [{ name: 'Alice', role: 'Builder', isolation: 'worktree' }],
      warning:
        'members.meta.json and inboxes are empty; launch fell back to config.json members. ' +
        'Run a fresh team bootstrap to persist stable member metadata.',
    });
  });

  it('warns and continues without explicit members for unparsable empty config fallback', async () => {
    const warn = vi.fn<(message: string) => void>();
    const result = await resolveLaunchExpectedMembers(
      {
        teamName: 'team-a',
        configRaw: '{not json',
      },
      makePorts({ warn })
    );

    expect(warn).toHaveBeenCalledWith(
      '[team-a] Failed to parse config.json for launch fallback members'
    );
    expect(result).toEqual({
      source: 'config-fallback',
      members: [],
      warning:
        'Config could not be parsed during launch roster discovery. ' +
        'Launch will continue without explicit teammate names.',
    });
  });
});
