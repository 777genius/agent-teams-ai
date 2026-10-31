import { TeamRuntimeTurnSettledTargetResolver } from '@features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver';
import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamTranscriptProjectResolver } from '@main/services/team/TeamTranscriptProjectResolver';
import { encodePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { snapshotDirectoryTree } from '../../../helpers/directorySnapshot';

import type { TeamConfig } from '@shared/types';

describe('TeamRuntimeTurnSettledTargetResolver', () => {
  it('resolves a Claude Stop transcript path to an active Anthropic teammate', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => [{ teamName: 'team-a', displayName: 'team-a' } as never]),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Alice', providerId: 'anthropic' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => [
          {
            memberName: 'Alice',
            sessionId: 'ses-1',
            filePath: '/tmp/ses-1.jsonl',
            mtimeMs: 1,
          },
        ]),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        transcriptPath: '/tmp/ses-1.jsonl',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'alice' });
  });

  it('rejects matches for removed or non-Anthropic teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => [{ teamName: 'team-a', displayName: 'team-a' } as never]),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'bob', providerId: 'opencode' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => [
          {
            memberName: 'bob',
            sessionId: 'ses-1',
            filePath: '/tmp/ses-1.jsonl',
            mtimeMs: 1,
          },
        ]),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('resolves Codex native turn-settled payloads from durable team/member identity', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => {
          throw new Error('codex path should not scan attributed files');
        }),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'codex' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => []),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'codex',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'jack' });
  });

  it('rejects Codex native events for non-Codex teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'anthropic' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'codex',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('preserves config provider metadata when member meta lacks provider fields', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [
            {
              name: 'Jack',
              providerBackendId: 'codex-native',
              model: 'opencode/openai/gpt-oss',
            },
          ],
        }) satisfies TeamConfig),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => [
          {
            name: 'Jack',
            role: 'developer',
            agentType: 'general-purpose',
            color: 'blue',
          },
        ]),
      } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('resolves OpenCode turn-settled payloads from durable team/member identity', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => {
          throw new Error('opencode path should not scan attributed files');
        }),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'opencode' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => []),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'jack' });
  });

  it('rejects OpenCode events for non-OpenCode teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      isManagedByThisProfile: async () => true,
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'codex' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });
});

describe('TeamRuntimeTurnSettledTargetResolver with teams of several app profiles', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  /** A team whose teammate bob has a root session transcript in the team's project. */
  async function writeTeamWithMemberSession(
    teamsDir: string,
    teamName: string,
    projectPath: string
  ): Promise<{ projectDir: string; memberSessionId: string; memberTranscriptPath: string }> {
    const leadSessionId = `${teamName}-lead-session`;
    const memberSessionId = `${teamName}-bob-session`;
    await fs.mkdir(path.join(teamsDir, teamName), { recursive: true });
    await fs.writeFile(
      path.join(teamsDir, teamName, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          leadSessionId,
          members: [
            { name: 'team-lead', agentType: 'team-lead', cwd: projectPath },
            { name: 'bob', agentType: 'general-purpose', cwd: projectPath },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${leadSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-04-15T14:02:00.000Z',
        type: 'user',
        teamName,
        agentName: 'team-lead',
        message: { role: 'user', content: `Lead for team "${teamName}" (${teamName})` },
      })}\n`,
      'utf8'
    );
    const memberTranscriptPath = path.join(projectDir, `${memberSessionId}.jsonl`);
    await fs.writeFile(
      memberTranscriptPath,
      `${[
        {
          timestamp: '2026-04-15T14:02:01.000Z',
          type: 'user',
          teamName,
          agentName: 'bob',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "bob".`,
          },
        },
        {
          timestamp: '2026-04-15T14:02:05.000Z',
          type: 'assistant',
          teamName,
          agentName: 'bob',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-task-start',
                name: 'mcp__agent-teams__task_start',
                input: { teamName, taskId: 'task-1' },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
      'utf8'
    );
    return { projectDir, memberSessionId, memberTranscriptPath };
  }

  it('matches a Claude Stop hook against own teams only, before the scan limit', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-settled-target-profiles-'));
    setClaudeBasePathOverride(tmpDir);
    const teamsDir = path.join(tmpDir, 'teams');
    const foreignTeam = 'other-profile-team';
    const ownTeam = 'own-profile-team';
    const foreign = await writeTeamWithMemberSession(teamsDir, foreignTeam, '/Users/test/foreign');
    const own = await writeTeamWithMemberSession(teamsDir, ownTeam, '/Users/test/own');
    await claimTeamForThisProfile({
      teamsBasePath: teamsDir,
      teamName: foreignTeam,
      reason: 'create',
      profileScope: 'other-profile',
    });
    await claimTeamForThisProfile({
      teamsBasePath: teamsDir,
      teamName: ownTeam,
      reason: 'create',
      profileScope: 'this-profile',
    });
    const ownership = createTeamProfileOwnership({
      isTrackedInThisProcess: () => false,
      getTeamsBasePath: () => teamsDir,
      getProfileScope: () => 'this-profile',
    });
    // The finder may write every team here, so only the ownership filter of the resolver
    // keeps the other profile's team untouched.
    const configReader = new TeamConfigReader();
    const memberLogsFinder = new TeamMemberLogsFinder(
      configReader,
      undefined,
      undefined,
      new TeamTranscriptProjectResolver(async () => true, {
        getConfig: (teamName) => configReader.getConfigSnapshot(teamName),
      })
    );
    const listAttributedMemberFiles = vi.spyOn(memberLogsFinder, 'listAttributedMemberFiles');
    const foreignTeamBefore = await snapshotDirectoryTree(path.join(teamsDir, foreignTeam));
    const foreignProjectBefore = await snapshotDirectoryTree(foreign.projectDir);
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: async () => [
          { teamName: foreignTeam, displayName: foreignTeam } as never,
          { teamName: ownTeam, displayName: ownTeam } as never,
        ],
        getConfig: (teamName) => configReader.getConfig(teamName),
      },
      membersMetaStore: new TeamMembersMetaStore(),
      isManagedByThisProfile: (teamName) => ownership.isManagedByThisProfile(teamName),
      memberLogsFinder,
      maxTeamsToScan: 1,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: own.memberSessionId,
        transcriptPath: own.memberTranscriptPath,
      })
    ).resolves.toEqual({ ok: true, teamName: ownTeam, memberName: 'bob' });

    expect(listAttributedMemberFiles.mock.calls).toEqual([[ownTeam]]);
    expect(await snapshotDirectoryTree(path.join(teamsDir, foreignTeam))).toEqual(
      foreignTeamBefore
    );
    expect(await snapshotDirectoryTree(foreign.projectDir)).toEqual(foreignProjectBefore);
  });

  it('keeps the scan limit for own teams and stops checking ownership once it is reached', async () => {
    const isManagedByThisProfile = vi.fn(async (teamName: string) => teamName !== 'foreign');
    const listAttributedMemberFiles = vi.fn(async () => []);
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: async () =>
          ['foreign', 'own-a', 'own-b'].map(
            (teamName) => ({ teamName, displayName: teamName }) as never
          ),
        getConfig: async () => null,
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      isManagedByThisProfile,
      memberLogsFinder: { listAttributedMemberFiles },
      maxTeamsToScan: 1,
    });

    await resolver.resolve({
      schemaVersion: 1,
      provider: 'claude',
      hookEventName: 'Stop',
      sourceId: 'source-1',
      payloadHash: 'hash',
      recordedAt: '2026-04-29T12:00:00.000Z',
      sessionId: 'ses-1',
    });

    expect(listAttributedMemberFiles.mock.calls).toEqual([['own-a']]);
    expect(isManagedByThisProfile.mock.calls).toEqual([['foreign'], ['own-a']]);
  });

  it('treats a failing ownership check as another profile', async () => {
    const listAttributedMemberFiles = vi.fn(async () => []);
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: async () => [
          { teamName: 'unknown-owner', displayName: 'unknown-owner' } as never,
        ],
        getConfig: async () => null,
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      isManagedByThisProfile: async () => {
        throw new Error('ownership is unavailable');
      },
      memberLogsFinder: { listAttributedMemberFiles },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
      })
    ).resolves.toEqual({ ok: false, reason: 'no_matching_member_session' });
    expect(listAttributedMemberFiles).not.toHaveBeenCalled();
  });
});
