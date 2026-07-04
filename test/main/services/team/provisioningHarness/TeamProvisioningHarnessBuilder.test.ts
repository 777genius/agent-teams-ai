/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are owned by the harness temp workspace. */
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { access, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  assertNoSecretLikeFixtureValues,
  collectSecretLikeFixtureValues,
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  memberFixture,
  teamConfigFixture,
  teamMetaFixture,
  type TeamProvisioningHarness,
  TeamProvisioningHarnessBuilder,
} from './index';

import type { TeamProvisioningConfigFacadeReader } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningConfigMaintenanceMembersMetaStore } from '@main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { TeamConfig } from '@shared/types';

const harnesses: TeamProvisioningHarness[] = [];
const HOME_ENV_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;
const RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS = [':', '<', '>', '"', '|', '?', '*'] as const;
const ORIGINAL_HOME_ENV = Object.fromEntries(
  HOME_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof HOME_ENV_KEYS)[number], string | undefined>;

async function track(
  harnessPromise: Promise<TeamProvisioningHarness>
): Promise<TeamProvisioningHarness> {
  const harness = await harnessPromise;
  harnesses.push(harness);
  return harness;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listTempWorkspaceNames(prefix: string): Promise<string[]> {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

function restoreOriginalHomeEnv(): void {
  for (const key of HOME_ENV_KEYS) {
    const value = ORIGINAL_HOME_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setAutoDetectedHomeForTest(label: string): string {
  const homePath = path.join(os.tmpdir(), `team-provisioning-harness-${label}-${process.pid}`);
  process.env.HOME = homePath;
  delete process.env.USERPROFILE;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  return path.join(homePath, '.claude', 'teams');
}

function charLabel(char: string): string {
  return char.charCodeAt(0).toString(16).padStart(2, '0');
}

afterEach(async () => {
  try {
    for (const harness of harnesses.splice(0).reverse()) {
      await harness.cleanup();
    }
  } finally {
    restoreOriginalHomeEnv();
    setClaudeBasePathOverride(null);
  }
});

describe('TeamProvisioningHarnessBuilder', () => {
  it('creates isolated temp workspace paths and removes them during cleanup', async () => {
    setClaudeBasePathOverride(null);
    const originalTeamsBasePath = getTeamsBasePath();
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-test-' })
        .build()
    );

    expect(harness.paths.root).toContain('team-provisioning-harness-test-');
    expect((await stat(harness.paths.claudeRoot)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.teamsBase)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.tasksBase)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.projectsBase)).isDirectory()).toBe(true);
    expect(getTeamsBasePath()).toBe(harness.paths.teamsBase);
    expect(await pathExists(harness.paths.configPath(harness.teamName))).toBe(true);

    await harness.cleanup();

    expect(await pathExists(harness.paths.root)).toBe(false);
    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
    const newAutoTeamsBasePath = setAutoDetectedHomeForTest('success-cleanup-home');
    expect(getTeamsBasePath()).toBe(newAutoTeamsBasePath);
  });

  it('cleans temp workspace and restores path override when a side-effecting build fails', async () => {
    setClaudeBasePathOverride(null);
    const prefix = 'team-provisioning-harness-failed-build-test-';
    const originalTeamsBasePath = getTeamsBasePath();
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const invalidTeamName = `invalid${String.fromCharCode(0)}team`;

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(invalidTeamName)
        .build()
    ).rejects.toThrow();

    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
    const newAutoTeamsBasePath = setAutoDetectedHomeForTest('failed-build-cleanup-home');
    expect(getTeamsBasePath()).toBe(newAutoTeamsBasePath);
    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it('rejects traversal team names before creating temp dirs or writing escaped files', async () => {
    const prefix = 'team-provisioning-harness-invalid-team-path-test-';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-team-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalTeamName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(traversalTeamName)
        .build()
    ).rejects.toThrow(/Invalid team name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects traversal inbox member names before creating temp dirs or writing escaped files', async () => {
    const prefix = 'team-provisioning-harness-invalid-member-path-test-';
    const teamName = 'invalid-member-path-team';
    const outsideDir = path.join(
      os.tmpdir(),
      `team-provisioning-harness-member-escape-${process.pid}`
    );
    await rm(outsideDir, { recursive: true, force: true });
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const traversalMemberName = path.join('..', '..', '..', path.basename(outsideDir));

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            members: [memberFixture.lead(), memberFixture.codex(traversalMemberName)],
          })
        )
        .build()
    ).rejects.toThrow(/Invalid member name/);

    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    expect(await pathExists(outsideDir)).toBe(false);
  });

  it('rejects traversal member names in inbox paths before writing escaped files', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());
    const outsideFileName = `team-provisioning-harness-inbox-escape-${process.pid}`;
    const outsideFile = path.join(os.tmpdir(), `${outsideFileName}.json`);
    await rm(outsideFile, { force: true });
    const traversalMemberName = path.join('..', '..', '..', '..', '..', outsideFileName);

    await expect(
      (async () => {
        const inboxPath = harness.paths.inboxPath(harness.teamName, traversalMemberName);
        await writeFile(inboxPath, '{}\n', 'utf8');
      })()
    ).rejects.toThrow(/Invalid member name/);

    expect(await pathExists(outsideFile)).toBe(false);
  });

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects team names containing reserved filename char %s before side effects',
    async (reservedChar) => {
      const prefix = `team-provisioning-harness-reserved-team-${charLabel(reservedChar)}-`;
      const beforeEntries = await listTempWorkspaceNames(prefix);
      const teamName = `bad${reservedChar}team`;

      await expect(
        TeamProvisioningHarnessBuilder.create()
          .withTempWorkspace({ prefix })
          .withTeam(teamName)
          .build()
      ).rejects.toThrow(/Invalid team name/);

      expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    }
  );

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects member names containing reserved filename char %s before side effects',
    async (reservedChar) => {
      const prefix = `team-provisioning-harness-reserved-member-${charLabel(reservedChar)}-`;
      const teamName = `reserved-member-team-${charLabel(reservedChar)}`;
      const beforeEntries = await listTempWorkspaceNames(prefix);

      await expect(
        TeamProvisioningHarnessBuilder.create()
          .withTempWorkspace({ prefix })
          .withTeam(
            teamName,
            teamConfigFixture.basic({
              teamName,
              members: [
                memberFixture.lead(),
                memberFixture.codex(`bad${reservedChar}member`),
              ],
            })
          )
          .build()
      ).rejects.toThrow(/Invalid member name/);

      expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
    }
  );

  it.each(RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS)(
    'rejects reserved filename char %s in member inbox paths before writing files',
    async (reservedChar) => {
      const harness = await track(TeamProvisioningHarnessBuilder.create().build());
      const memberName = `bad${reservedChar}member`;
      const literalInboxPath = path.join(
        harness.paths.teamDir(harness.teamName),
        'inboxes',
        `${memberName}.json`
      );

      await expect(
        (async () => {
          const inboxPath = harness.paths.inboxPath(harness.teamName, memberName);
          await writeFile(inboxPath, '{}\n', 'utf8');
        })()
      ).rejects.toThrow(/Invalid member name/);

      expect(await pathExists(literalInboxPath)).toBe(false);
    }
  );

  it('validates caller fixtures before creating temp dirs or applying path overrides', async () => {
    const prefix = 'team-provisioning-harness-invalid-fixture-test-';
    const teamName = 'invalid-fixture-team';
    const originalTeamsBasePath = getTeamsBasePath();
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const invalidConfig = {
      ...teamConfigFixture.basic({ teamName }),
      apiKey: 'fixture-placeholder',
    } as unknown as TeamConfig;

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(teamName, invalidConfig)
        .build()
    ).rejects.toThrow(/Secret-like fixture values/);

    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it('rejects a second active path override instead of stacking global overrides', async () => {
    const originalTeamsBasePath = getTeamsBasePath();
    const first = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-first-override-test-' })
        .build()
    );
    const secondPrefix = 'team-provisioning-harness-second-override-test-';
    const beforeSecondEntries = await listTempWorkspaceNames(secondPrefix);

    expect(getTeamsBasePath()).toBe(first.paths.teamsBase);
    await expect(
      TeamProvisioningHarnessBuilder.create().withTempWorkspace({ prefix: secondPrefix }).build()
    ).rejects.toThrow(/already owns a Claude path override/);

    expect(getTeamsBasePath()).toBe(first.paths.teamsBase);
    expect(await listTempWorkspaceNames(secondPrefix)).toEqual(beforeSecondEntries);

    await first.cleanup();
    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
  });

  it('restores a previous custom Claude path override during cleanup', async () => {
    const customClaudeRoot = path.join(
      os.tmpdir(),
      `team-provisioning-harness-custom-override-${process.pid}`
    );
    setClaudeBasePathOverride(customClaudeRoot);
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-custom-override-test-' })
        .build()
    );

    expect(getTeamsBasePath()).toBe(harness.paths.teamsBase);

    await harness.cleanup();

    expect(getTeamsBasePath()).toBe(path.join(customClaudeRoot, 'teams'));
  });

  it.each([
    ['absolute prefix', { prefix: '/tmp/escape-' }],
    ['parent prefix', { prefix: '..' }],
    ['separator prefix', { prefix: 'bad/prefix-' }],
    ['windows separator prefix', { prefix: 'bad\\prefix-' }],
    ['absolute projectDirName', { projectDirName: '/tmp/escape' }],
    ['parent projectDirName', { projectDirName: '..' }],
    ['separator projectDirName', { projectDirName: 'nested/project' }],
    ['windows separator projectDirName', { projectDirName: 'nested\\project' }],
    ['reserved prefix colon', { prefix: 'bad:prefix-' }],
    ['reserved prefix less-than', { prefix: 'bad<prefix-' }],
    ['reserved prefix greater-than', { prefix: 'bad>prefix-' }],
    ['reserved prefix quote', { prefix: 'bad"prefix-' }],
    ['reserved prefix pipe', { prefix: 'bad|prefix-' }],
    ['reserved prefix question', { prefix: 'bad?prefix-' }],
    ['reserved prefix star', { prefix: 'bad*prefix-' }],
    ['reserved projectDirName colon', { projectDirName: 'bad:project' }],
    ['reserved projectDirName less-than', { projectDirName: 'bad<project' }],
    ['reserved projectDirName greater-than', { projectDirName: 'bad>project' }],
    ['reserved projectDirName quote', { projectDirName: 'bad"project' }],
    ['reserved projectDirName pipe', { projectDirName: 'bad|project' }],
    ['reserved projectDirName question', { projectDirName: 'bad?project' }],
    ['reserved projectDirName star', { projectDirName: 'bad*project' }],
  ])('rejects unsafe temp workspace %s', async (_label, options) => {
    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ ...options, applyPathOverride: false })
        .build()
    ).rejects.toThrow(/Invalid temp workspace/);
  });

  it('provides deterministic defaults through fake stores, clock, and uuid hooks', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());

    expect(harness.teamName).toBe(HARNESS_DEFAULT_TEAM_NAME);
    expect(harness.clock.nowIso()).toBe(HARNESS_DEFAULT_NOW_ISO);
    expect(harness.uuid.next()).toBe('harness-uuid-1');
    expect(harness.uuid.next()).toBe('harness-uuid-2');
    expect(harness.uuid.generated()).toEqual(['harness-uuid-1', 'harness-uuid-2']);

    const config = await harness.stores.configReader.getConfig(HARNESS_DEFAULT_TEAM_NAME);
    expect(config).toMatchObject({
      name: HARNESS_DEFAULT_TEAM_NAME,
      projectPath: harness.paths.projectPath,
      leadSessionId: 'harness-lead-session',
    });
    expect(config?.members?.map((member) => `${member.name}:${member.providerId}`)).toEqual([
      'Lead:codex',
      'Builder:codex',
    ]);

    const persistedConfig = JSON.parse(
      await readFile(harness.paths.configPath(HARNESS_DEFAULT_TEAM_NAME), 'utf8')
    ) as unknown;
    expect(persistedConfig).toEqual(config);

    await expect(
      harness.stores.teamMetaStore.getMeta(HARNESS_DEFAULT_TEAM_NAME)
    ).resolves.toMatchObject({
      cwd: harness.paths.projectPath,
      providerId: 'codex',
    });
    await expect(
      harness.stores.membersMetaStore.getMembers(HARNESS_DEFAULT_TEAM_NAME)
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'Builder',
        providerBackendId: 'codex-native',
      }),
      expect.objectContaining({
        name: 'Lead',
        providerBackendId: 'codex-native',
      }),
    ]);
  });

  it('exposes explicit fake store ports for migrated provisioning helpers', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());
    const configReaderPort: TeamProvisioningConfigFacadeReader = harness.stores.configReader;
    const membersMetaPort: TeamProvisioningConfigMaintenanceMembersMetaStore =
      harness.stores.membersMetaStore;
    const teamMetaReadPort: Pick<TeamMetaStore, 'getMeta'> = harness.stores.teamMetaStore;

    expect(Object.keys(harness.stores.configReader).sort()).toEqual([
      'getConfig',
      'getConfigSnapshot',
      'getConfigVerified',
      'readTeamConfigRaw',
    ]);
    expect(Object.keys(harness.stores.membersMetaStore).sort()).toEqual([
      'getMembers',
      'getMeta',
      'writeMembers',
    ]);
    expect(Object.keys(harness.stores.teamMetaStore).sort()).toEqual(['getMeta']);
    expect('updateConfig' in harness.stores.configReader).toBe(false);
    expect('writeMeta' in harness.stores.teamMetaStore).toBe(false);

    await expect(configReaderPort.getConfig(HARNESS_DEFAULT_TEAM_NAME)).resolves.toMatchObject({
      name: HARNESS_DEFAULT_TEAM_NAME,
    });
    await expect(teamMetaReadPort.getMeta(HARNESS_DEFAULT_TEAM_NAME)).resolves.toMatchObject({
      cwd: harness.paths.projectPath,
    });

    await membersMetaPort.writeMembers(
      'port-team',
      [
        memberFixture.codex(' beta ', { role: ' Builder ' }),
        memberFixture.codex('alpha'),
        memberFixture.codex('alpha-2'),
        memberFixture.codex('   '),
      ],
      { providerBackendId: 'adapter' }
    );

    await expect(membersMetaPort.getMembers('port-team')).resolves.toEqual([
      expect.objectContaining({ name: 'alpha' }),
      expect.objectContaining({ name: 'beta', role: 'Builder' }),
    ]);
    await expect(harness.stores.membersMetaStore.getMeta('port-team')).resolves.toMatchObject({
      providerBackendId: 'adapter',
    });
  });

  it('honors explicit team fixtures and deterministic uuid sequences', async () => {
    const teamName = 'alpha-team';
    const alice = memberFixture.opencode('alice', { role: 'Runtime Engineer' });
    const bob = memberFixture.anthropic('bob', { model: 'harness-anthropic-model' });
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withClock('2026-02-03T04:05:06.000Z')
        .withUuidSequence(['run-alpha', 'run-beta'])
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            projectPath: '/tmp/agent-teams-harness/alpha',
            members: [memberFixture.lead(), alice],
          })
        )
        .withTeamMeta(
          teamName,
          teamMetaFixture.basic({
            displayName: 'Alpha Team',
            cwd: '/tmp/agent-teams-harness/alpha',
          })
        )
        .withMembersMeta(teamName, [alice, bob])
        .build()
    );

    await expect(harness.stores.configReader.getConfigSnapshot(teamName)).resolves.toMatchObject({
      name: teamName,
      members: [expect.objectContaining({ name: 'Lead' }), alice],
    });
    await expect(harness.stores.teamMetaStore.getMeta(teamName)).resolves.toMatchObject({
      displayName: 'Alpha Team',
      cwd: '/tmp/agent-teams-harness/alpha',
    });
    await expect(harness.stores.membersMetaStore.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({
        name: alice.name,
        providerId: alice.providerId,
        role: alice.role,
      }),
      expect.objectContaining({
        name: bob.name,
        providerId: bob.providerId,
        model: bob.model,
      }),
    ]);
    expect(harness.clock.nowIso()).toBe('2026-02-03T04:05:06.000Z');
    expect(harness.uuid.next()).toBe('run-alpha');
    expect(harness.uuid.next()).toBe('run-beta');
    expect(harness.uuid.next()).toBe('harness-uuid-3');
  });

  it('keeps built-in fixture values secret-free and exposes a failing scanner for bad keys', () => {
    const sampleFixtures = {
      members: [
        memberFixture.lead(),
        memberFixture.codex('builder'),
        memberFixture.anthropic('reviewer'),
        memberFixture.opencode('runtime'),
      ],
      config: teamConfigFixture.basic({
        teamName: 'secret-free-team',
        members: [memberFixture.lead(), memberFixture.codex('builder')],
      }),
      meta: teamMetaFixture.basic({ displayName: 'Secret Free Team' }),
    };

    expect(collectSecretLikeFixtureValues(sampleFixtures)).toEqual([]);
    expect(() => assertNoSecretLikeFixtureValues(sampleFixtures)).not.toThrow();
    expect(collectSecretLikeFixtureValues({ apiKey: 'fixture-placeholder' })).toEqual([
      expect.objectContaining({ path: '$.apiKey' }),
    ]);
    expect(
      collectSecretLikeFixtureValues({ nested: { authToken: 'fixture-placeholder' } })
    ).toEqual([expect.objectContaining({ path: '$.nested.authToken' })]);
    expect(collectSecretLikeFixtureValues({ value: 'Bearer [defanged fixture]' })).toEqual([]);
    expect(
      collectSecretLikeFixtureValues({ value: `Bearer ${'fixtureToken'.repeat(2)}` })
    ).toEqual([
      expect.objectContaining({
        path: '$.value',
        patternName: 'bearer-token',
        stringLength: 31,
        redactedValue: '<redacted>',
      }),
    ]);
    expect(() =>
      assertNoSecretLikeFixtureValues({ member: { password: 'fixture-placeholder' } })
    ).toThrow(/Secret-like fixture values/);
  });

  it('does not include matched secret-like raw values in thrown scanner errors', () => {
    const matchedValue = `Bearer ${'fixtureToken'.repeat(2)}`;

    let thrown: unknown;
    try {
      assertNoSecretLikeFixtureValues({ value: matchedValue });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(matchedValue);
    expect(message).toContain('<redacted>');
    expect(message).toContain('length=31');
  });
});
