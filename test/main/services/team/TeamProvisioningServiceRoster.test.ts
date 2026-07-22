import { getMixedLaunchFallbackRecoveryError } from '@main/services/team/provisioning/TeamProvisioningLaunchCompatibility';
import {
  probeLaunchCompatibility,
  resolveLaunchExpectedMembers,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { describe, expect, it, vi } from 'vitest';

import type { TeamMember } from '@shared/types';

function makePorts(
  overrides: Partial<TeamProvisioningLaunchExpectedMembersPorts> = {}
): TeamProvisioningLaunchExpectedMembersPorts {
  return {
    readLaunchState: vi.fn(async () => null),
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    getMembers: vi.fn(async () => [] as TeamMember[]),
    listInboxNames: vi.fn(async () => [] as string[]),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('team provisioning launch roster discovery', () => {
  it('inbox fallback keeps -1 names but drops auto-suffixed -2+ when base exists', async () => {
    const result = await resolveLaunchExpectedMembers(
      { teamName: 't', configRaw: '{}' },
      makePorts({
        listInboxNames: vi.fn(async () => [
          'dev',
          'dev-1',
          'dev-2',
          'dev-3',
          'user',
          'team-lead',
          'DEV-2',
        ]),
      })
    );

    expect(result.source).toBe('inboxes');
    expect(result.members.map((member) => member.name)).toEqual(['dev', 'dev-1']);
  });

  it('inbox fallback ignores cross-team pseudo and qualified external names', async () => {
    const result = await resolveLaunchExpectedMembers(
      { teamName: 't', configRaw: '{}' },
      makePorts({
        listInboxNames: vi.fn(async () => [
          'dev',
          'cross-team:team-alpha-super',
          'cross-team-team-alpha-super',
          'team-alpha-super.user',
        ]),
      })
    );

    expect(result.source).toBe('inboxes');
    expect(result.members.map((member) => member.name)).toEqual(['dev']);
  });

  it('inbox fallback keeps suffixed name if base is absent', async () => {
    const result = await resolveLaunchExpectedMembers(
      { teamName: 't', configRaw: '{}' },
      makePorts({
        listInboxNames: vi.fn(async () => ['alice-2']),
      })
    );

    expect(result.source).toBe('inboxes');
    expect(result.members.map((member) => member.name)).toEqual(['alice-2']);
  });

  it('inbox fallback merges provider/model overrides from config for multimodel reconnect', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'bob', role: 'reviewer', provider: 'codex', model: 'gpt-5.4' }],
    });

    const result = await resolveLaunchExpectedMembers(
      { teamName: 't', configRaw },
      makePorts({
        listInboxNames: vi.fn(async () => ['bob']),
      })
    );

    expect(result.source).toBe('inboxes');
    expect(result.members).toEqual([
      { name: 'bob', role: 'reviewer', workflow: undefined, providerId: 'codex', model: 'gpt-5.4' },
    ]);
    expect(result.warning).toContain('best-effort');
  });

  it('members.meta.json fallback never returns reserved names (user/team-lead)', async () => {
    const result = await resolveLaunchExpectedMembers(
      { teamName: 't', configRaw: '{}' },
      makePorts({
        getMembers: vi.fn(async () => [
          { name: 'user', agentType: 'general-purpose' },
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'Alice', role: 'dev', agentType: 'general-purpose' },
        ]),
      })
    );

    expect(result.source).toBe('members-meta');
    expect(result.members.map((member) => member.name)).toEqual(['Alice']);
  });

  it.each([
    ['tombstone-only', [{ name: 'alice', agentType: 'general-purpose', removedAt: 123 }]],
    ['empty', []],
  ])('treats valid %s members.meta.json as authoritative across restarts', async (_label, meta) => {
    const listInboxNames = vi.fn(async () => ['alice']);
    const configRaw = JSON.stringify({ members: [{ name: 'alice', role: 'developer' }] });

    for (let restart = 0; restart < 2; restart += 1) {
      const service = new TeamProvisioningService(
        {} as never,
        { listInboxNames } as never,
        {
          getMeta: vi.fn(async () => ({ version: 1, members: meta })),
          getMembers: vi.fn(async () => meta),
          writeMembers: vi.fn(async () => undefined),
        } as never
      );
      const report = await (
        service as unknown as {
          resolveLaunchExpectedMembers(
            teamName: string,
            rawConfig: string,
            providerId?: string
          ): Promise<{ source: string; members: { name: string }[] }>;
        }
      ).resolveLaunchExpectedMembers('t', configRaw, 'codex');

      expect(report).toMatchObject({ source: 'members-meta', members: [] });
    }
    expect(listInboxNames).not.toHaveBeenCalled();
  });

  it('preserves removal tombstones when launch persistence rewrites the active roster', async () => {
    const writeMembers = vi.fn(
      async (_teamName: string, _members: unknown[], _options?: unknown) => undefined
    );
    const service = new TeamProvisioningService(
      {} as never,
      {} as never,
      {
        getMeta: vi.fn(async () => ({
          version: 1,
          members: [
            { name: 'alice', role: 'Developer', removedAt: 123 },
            { name: 'bob', role: 'Reviewer' },
          ],
        })),
        getMembers: vi.fn(async () => []),
        writeMembers,
      } as never
    );

    await (
      service as unknown as {
        persistMembersMeta(
          teamName: string,
          request: { members: { name: string; role: string }[] }
        ): Promise<void>;
      }
    ).persistMembersMeta('t', {
      members: [
        { name: 'alice', role: 'stale config role' },
        { name: 'bob', role: 'Reviewer' },
      ],
    });

    expect(writeMembers).toHaveBeenCalledWith(
      't',
      expect.arrayContaining([
        expect.objectContaining({ name: 'alice', role: 'Developer', removedAt: 123 }),
        expect.objectContaining({ name: 'bob', role: 'Reviewer' }),
      ]),
      { providerBackendId: undefined }
    );
    expect(writeMembers.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('config fallback never returns reserved names (user/team-lead)', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'user' }, { name: 'bob' }],
    });

    const result = await resolveLaunchExpectedMembers({ teamName: 't', configRaw }, makePorts());

    expect(result.source).toBe('config-fallback');
    expect(result.members.map((member) => member.name)).toEqual(['bob']);
  });

  it('marks pure Claude/Codex legacy config without members.meta.json as repairable', async () => {
    const configRaw = JSON.stringify({
      name: 'legacy-pure',
      members: [
        { name: 'alice', role: 'reviewer', provider: 'anthropic', model: 'claude-opus-4-6' },
        { name: 'tom', role: 'developer', provider: 'codex', model: 'gpt-5.4' },
      ],
    });

    const report = await probeLaunchCompatibility(
      { teamName: 'legacy-pure', configRaw, leadProviderId: 'anthropic' },
      makePorts()
    );

    expect(report).toMatchObject({
      level: 'repairable',
      rosterSource: 'config',
      repairAction: 'materialize-members-meta',
    });
    expect(report.members.map((member) => member.name)).toEqual(['alice', 'tom']);
  });

  it('rejects inbox fallback when OpenCode metadata is incomplete without members.meta truth', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'tom', role: 'developer', provider: 'opencode' }],
    });

    await expect(
      resolveLaunchExpectedMembers(
        { teamName: 't', configRaw, leadProviderId: 'codex' },
        makePorts({
          listInboxNames: vi.fn(async () => ['tom']),
        })
      )
    ).rejects.toThrow(getMixedLaunchFallbackRecoveryError());
  });

  it('marks complete mixed OpenCode config fallback as repairable', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [
        { name: 'tom', role: 'developer', provider: 'opencode', model: 'minimax-m2.5-free' },
      ],
    });

    const report = await probeLaunchCompatibility(
      { teamName: 't', configRaw, leadProviderId: 'codex' },
      makePorts()
    );

    expect(report).toMatchObject({
      level: 'repairable',
      rosterSource: 'config',
      repairAction: 'materialize-members-meta',
    });
    expect(report.members).toMatchObject([
      { name: 'tom', role: 'developer', providerId: 'opencode', model: 'minimax-m2.5-free' },
    ]);
  });

  it('prefers complete mixed OpenCode config over inbox names when members.meta is missing', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [
        { name: 'tom', role: 'developer', provider: 'opencode', model: 'minimax-m2.5-free' },
      ],
    });

    const report = await probeLaunchCompatibility(
      { teamName: 't', configRaw, leadProviderId: 'codex' },
      makePorts({
        listInboxNames: vi.fn(async () => ['tom']),
      })
    );

    expect(report).toMatchObject({
      level: 'repairable',
      rosterSource: 'config',
      repairAction: 'materialize-members-meta',
    });
  });

  it('rejects mixed OpenCode config fallback when the side lane is missing an explicit model', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'tom', role: 'developer', provider: 'opencode' }],
    });

    await expect(
      resolveLaunchExpectedMembers(
        { teamName: 't', configRaw, leadProviderId: 'codex' },
        makePorts()
      )
    ).rejects.toThrow(getMixedLaunchFallbackRecoveryError());
  });

  it('rejects config fallback when an OpenCode-looking model is missing an explicit provider', async () => {
    const configRaw = JSON.stringify({
      name: 't',
      members: [{ name: 'tom', role: 'developer', model: 'opencode/minimax-m2.5-free' }],
    });

    await expect(
      resolveLaunchExpectedMembers(
        { teamName: 't', configRaw, leadProviderId: 'codex' },
        makePorts()
      )
    ).rejects.toThrow(getMixedLaunchFallbackRecoveryError());
  });
});
