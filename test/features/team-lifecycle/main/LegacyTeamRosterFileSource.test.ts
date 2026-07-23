import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
} from '@features/internal-storage/contracts';
import { AdoptTeamRoster, type TeamRosterRepository } from '@features/team-lifecycle';
import {
  type LegacyTeamRosterFileOpen,
  LegacyTeamRosterFileSource,
} from '@features/team-lifecycle/main/infrastructure/LegacyTeamRosterFileSource';
import { parseMemberId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);

describe('LegacyTeamRosterFileSource', () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  async function source(openFile?: LegacyTeamRosterFileOpen): Promise<{
    fileSource: LegacyTeamRosterFileSource;
    teamDirectory: string;
  }> {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-team-roster-'));
    const teamDirectory = path.join(temporaryDirectory, 'atlas');
    await fs.mkdir(teamDirectory);
    const [canonicalTeamDirectory, teamDirectoryStat] = await Promise.all([
      fs.realpath(teamDirectory),
      fs.lstat(teamDirectory, { bigint: true }),
    ]);
    const directoryFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          canonicalPath: canonicalTeamDirectory,
          device: teamDirectoryStat.dev.toString(),
          inode: teamDirectoryStat.ino.toString(),
        }),
        'utf8'
      )
      .digest('hex');
    const createdAt = '2026-07-23T09:00:00.000Z';
    const serializedIdentity = `${JSON.stringify(
      {
        schemaVersion: 1,
        teamId,
        createdAt,
      },
      null,
      2
    )}\n`;
    await fs.writeFile(path.join(teamDirectory, 'team.identity.json'), serializedIdentity);
    const identityChecksum = createHash('sha256').update(serializedIdentity, 'utf8').digest('hex');
    const identityGateway: TeamIdentityReadGateway = {
      listTeamIdentities: vi.fn(async () => []),
      getTeamIdentity: vi.fn(async () => ({
        teamId,
        state: 'active' as const,
        legacyKey: parseLegacyTeamKey('atlas'),
        directoryFingerprint: parseDirectoryFingerprint(directoryFingerprint),
        workspaceBinding: {
          workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
          generation: 1,
        },
        adoptionIntentId: parseTeamAdoptionIntentId(`adoption_${'c'.repeat(32)}`),
        identityChecksum: parseTeamIdentityChecksum(identityChecksum),
        createdAt,
        activatedAt: '2026-07-23T09:01:00.000Z',
        tombstonedAt: null,
      })),
    };
    return {
      fileSource: new LegacyTeamRosterFileSource({
        teamsRootPath: temporaryDirectory,
        teamIdentityGateway: identityGateway,
        openFile,
      }),
      teamDirectory,
    };
  }

  it('preserves raw case and auto-suffix evidence so adoption fails closed', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'Builder', providerId: 'codex' },
          { name: 'builder-2', providerId: 'codex' },
        ],
      })
    );
    await fs.writeFile(
      path.join(teamDirectory, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [{ name: 'Builder', providerId: 'codex' }],
      })
    );
    const repository: TeamRosterRepository = {
      getTeamRoster: vi.fn(async () => null),
      adoptTeamRosterIfAbsent: vi.fn(async (roster) => ({
        status: 'created' as const,
        roster,
      })),
    };
    const useCase = new AdoptTeamRoster({
      evidenceSource: fileSource,
      repository,
      memberIdFactory: {
        createMemberId: () => parseMemberId(`member_${'e'.repeat(32)}`),
      },
      clock: { now: () => new Date('2026-07-23T10:00:00.000Z') },
      fingerprintHasher: {
        sha256Hex: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
      },
    });

    await expect(useCase.execute({ teamId })).resolves.toEqual({
      status: 'blocked',
      reason: 'roster_identity_ambiguous',
    });
    expect(repository.adoptTeamRosterIfAbsent).not.toHaveBeenCalled();
  });

  it('blocks malformed metadata instead of falling back to config', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ members: [{ name: 'builder' }] })
    );
    await fs.writeFile(
      path.join(teamDirectory, 'members.meta.json'),
      JSON.stringify({ version: 2, members: [] })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toEqual({
      status: 'blocked',
      reason: 'legacy_evidence_invalid',
    });
  });

  it('adopts the legacy config provider field without silently defaulting it', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ members: [{ name: 'builder', provider: 'codex' }] })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toMatchObject({
      status: 'available',
      evidence: {
        members: [
          expect.objectContaining({
            legacyMemberKey: 'builder',
            providerId: 'codex',
          }),
        ],
      },
    });
  });

  it('accepts matching provider fields and preserves permissive legacy unknown fields', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({
        futureTopLevelField: { retainedByLegacyOwner: true },
        members: [
          {
            name: 'builder',
            providerId: 'codex',
            provider: 'codex',
            futureMemberField: 'ignored-by-roster-adoption',
          },
        ],
      })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toMatchObject({
      status: 'available',
      evidence: {
        members: [
          expect.objectContaining({
            legacyMemberKey: 'builder',
            providerId: 'codex',
          }),
        ],
      },
    });
  });

  it.each([
    {
      label: 'conflicting provider fields',
      member: { name: 'builder', providerId: 'codex', provider: 'opencode' },
    },
    {
      label: 'unknown providerId',
      member: { name: 'builder', providerId: 'future-provider' },
    },
    {
      label: 'unknown legacy provider',
      member: { name: 'builder', provider: 'future-provider' },
    },
  ])('blocks $label instead of selecting a provider default', async ({ member }) => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ members: [member] })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toEqual({
      status: 'blocked',
      reason: 'legacy_evidence_invalid',
    });
  });

  it('revalidates the directory fingerprint immediately after a roster read', async () => {
    const actualOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let replaced = false;
    const { fileSource, teamDirectory } = await source(async (targetPath, flags) => {
      const handle = await actualOpen(targetPath, flags);
      if (!replaced && path.basename(String(targetPath)) === 'config.json') {
        replaced = true;
        const observedTeamDirectory = path.dirname(String(targetPath));
        await fs.rename(observedTeamDirectory, `${observedTeamDirectory}.during-read`);
        await fs.mkdir(observedTeamDirectory);
      }
      return handle;
    });
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ members: [{ name: 'builder', providerId: 'codex' }] })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toEqual({
      status: 'blocked',
      reason: 'unsafe_team_directory',
    });
    expect(replaced).toBe(true);
  });

  it('blocks a directory replacement instead of rebinding the TeamId', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.rename(teamDirectory, `${teamDirectory}.replaced`);
    await fs.mkdir(teamDirectory);
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ members: [{ name: 'builder', provider: 'codex' }] })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toEqual({
      status: 'blocked',
      reason: 'unsafe_team_directory',
    });
  });

  it('blocks a changed canonical identity file before reading roster evidence', async () => {
    const { fileSource, teamDirectory } = await source();
    await fs.writeFile(
      path.join(teamDirectory, 'team.identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        teamId: parseTeamId(`team_${'f'.repeat(32)}`),
        createdAt: '2026-07-23T09:00:00.000Z',
      })
    );

    await expect(fileSource.readLegacyTeamRosterEvidence(teamId)).resolves.toEqual({
      status: 'blocked',
      reason: 'team_identity_unavailable',
    });
  });
});
