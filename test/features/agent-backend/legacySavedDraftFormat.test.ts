// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamPermanentDeletionIdentity } from '../../../packages/legacy-agent-host/src/adapters/lifecycle/TeamPermanentDeletionIdentity';
import { createLegacyStoppedTeamSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createDraftTeamConfig } from '../../../src/main/services/team/createDraftTeamConfig';
import {
  classifyLegacySavedTeamNativeRecords,
  isLegacySavedTeamProductRecords,
} from '../../../src/main/services/team/LegacySavedTeamNativeIdentity';
import { persistClearedStoppedTeamLiveRuntimeHandles } from '../../../src/main/services/team/provisioning/TeamProvisioningClearStoppedTeamRuntimeHandles';
import { TeamProvisioningConfigMaintenance } from '../../../src/main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import { applyConfigPostLaunchMaterialization } from '../../../src/main/services/team/provisioning/TeamProvisioningConfigMaterialization';
import { writeOpenCodeTeamConfig } from '../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeTeamConfigWriter';
import { TeamLaunchStateStore } from '../../../src/main/services/team/TeamLaunchStateStore';
import { TeamMembersMetaStore } from '../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';

import type { LegacyStoppedSourceOwners } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import type { ProviderModelLaunchIdentity, TeamCreateRequest } from '../../../src/shared/types';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-saved-draft' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, 'claude'),
  getTeamsBasePath: () => join(paths.root, 'claude/teams'),
  getTasksBasePath: () => join(paths.root, 'claude/tasks'),
  getAppDataPath: () => join(paths.root, 'app'),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function savedDraft(
  runtimeSelectionVersion?: 1,
  launchIdentity?: ProviderModelLaunchIdentity
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-saved-draft-format-')));
  roots.push(root);
  paths.root = root;
  const teamName = 'saved-format';
  const teamMetaStore = new TeamMetaStore();
  await createDraftTeamConfig(
    {
      teamName,
      ...(runtimeSelectionVersion === undefined ? {} : { runtimeSelectionVersion }),
      cwd: root,
      providerId: launchIdentity?.providerId ?? 'codex',
      model: 'TEST-model',
      members: [{ name: 'worker', role: 'developer' }],
    },
    { teamMetaStore, membersMetaStore: new TeamMembersMetaStore() }
  );
  if (launchIdentity) {
    const current = await teamMetaStore.getMeta(teamName);
    if (!current) throw new Error('TEST real writer did not create metadata');
    await teamMetaStore.writeMeta(teamName, { ...current, launchIdentity });
  }
  const team = join(root, 'claude/teams', teamName);
  const metaPath = join(team, 'team.meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  const roster: unknown = JSON.parse(readFileSync(join(team, 'members.meta.json'), 'utf8'));
  // Controlled owner facts isolate the actual writer/reader format boundary.
  // No provider, native custody or complete import qualification is claimed.
  const owners: LegacyStoppedSourceOwners = {
    backup: { withTeamIdentityFence: (_name, read) => read() },
    provisioning: {
      withStoppedTeamImportFence: (_name, read) => read(),
      readStoppedTeamImportRuntimeFacts: () => ({ active: 0 }),
      readStoppedTeamImportLifecycleFacts: () => ({ active: 0 }),
      readStoppedTeamImportStopFacts: () => ({ active: 0 }),
      readStoppedTeamImportDeliveryFacts: () => ({ active: 0 }),
    },
    data: {
      readStoppedTeamImportBackgroundFacts: () => ({ active: 0 }),
      readStoppedTeamImportCommandFacts: async () => ({
        known: true,
        pending: 0,
        revision: 'TEST',
      }),
      readStoppedTeamImportNotificationFacts: async () => ({
        known: true,
        pending: 0,
        revision: 'TEST',
      }),
    },
    launch: new TeamLaunchStateStore(),
  };
  const source = createLegacyStoppedTeamSource(
    {
      sourceOwnerId: 'TEST-owner',
      sourceId: 'TEST-source',
      contextId: 'TEST-context',
      teamName,
      roots: [
        { category: 'team', path: team },
        { category: 'tasks', path: join(root, 'claude/tasks', teamName) },
      ],
      isCurrent: () => true,
    },
    owners
  );
  return { teamName, meta, metaPath, roster, source, owners };
}

async function stoppedOpenCodeConfig(options: { color?: string; stopped?: boolean } = {}) {
  const f = await savedDraft(1, launchIdentity('opencode', 'explicit'));
  const configPath = join(dirname(f.metaPath), 'config.json');
  const request: TeamCreateRequest = {
    teamName: f.teamName, cwd: String(f.meta.cwd), providerId: 'opencode', model: 'TEST-model',
    ...(options.color === undefined ? {} : { color: options.color }),
    members: [{ name: 'worker', role: 'developer', providerId: 'opencode', model: 'TEST-model',
      mcpPolicy: { mode: 'appOnly' } }],
  };
  // These two production writer files are identical to the retained release writer.
  await writeOpenCodeTeamConfig(request, request.members, {
    getTeamsBasePath: () => join(paths.root, 'claude/teams'),
    writeFileAtomic: async (path, bytes) => { writeFileSync(path, bytes); }, invalidateTeam() {},
  });
  if (options.stopped) {
    const running = JSON.parse(readFileSync(configPath, 'utf8')) as { members: Record<string, unknown>[] };
    Object.assign(running.members.find(member => member.name === 'worker')!, {
      isActive: true, runtimePid: 12345, runtimeSessionId: 'TEST-native-session',
    });
    writeFileSync(configPath, JSON.stringify(running));
    expect(persistClearedStoppedTeamLiveRuntimeHandles(f.teamName, {
      readTeamConfigJson: () => readFileSync(configPath, 'utf8'),
      writeTeamConfigJson: (_team, bytes) => { writeFileSync(configPath, bytes); },
      invalidateTeamConfig() {},
    })).toBe(true);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> & {
    members: Record<string, unknown>[];
  };
  return { ...f, config, configPath };
}

async function maintainedOpenCodeConfig(mode: 'post-launch' | 'project-path') {
  const f = await stoppedOpenCodeConfig();
  const cwd = String(f.meta.cwd);
  f.config.projectPathHistory = Array.from({ length: 500 }, (_, i) => `/TEST-prior-${i}`);
  if (mode === 'post-launch') {
    applyConfigPostLaunchMaterialization({ teamName: f.teamName, config: f.config,
      projectPath: cwd, newSessionId: null, sessionHistory: [], language: 'en' });
    writeFileSync(f.configPath, JSON.stringify(f.config));
  } else {
    writeFileSync(f.configPath, JSON.stringify(f.config));
    const unused = (): never => { throw new Error('Unexpected maintenance port'); };
    const maintenance = new TeamProvisioningConfigMaintenance({
      limits: { teamJsonReadTimeoutMs: 1000, teamConfigMaxBytes: 256 * 1024, teamInboxMaxBytes: 256 * 1024 },
      ports: {
        getTeamsBasePath: () => join(paths.root, 'claude/teams'), getProjectsBasePath: unused,
        readRegularFileUtf8: async path => readFileSync(path, 'utf8'),
        writeFileUtf8: async (path, bytes) => { writeFileSync(path, bytes); },
        unlink: unused, readDir: unused, stat: unused, withCanonicalInboxLock: unused,
        scanForNewestProjectSession: unused,
        membersMetaStore: { getMembers: unused, writeMembers: unused },
        invalidateTeam() {}, getLanguage: unused, now: unused,
        logger: { info() {}, warn: unused, debug: unused },
      },
    });
    await maintenance.updateConfigProjectPath(f.teamName, cwd);
  }
  const config = JSON.parse(readFileSync(f.configPath, 'utf8')) as typeof f.config;
  return { ...f, config };
}

describe('actual saved-draft product format', () => {
  it.each(['async', 'sync'] as const)(
    'reads the actual lifecycle %s backup identity writer without adopting its authority', async mode => {
      const f = await stoppedOpenCodeConfig();
      const initial = await f.source.fenced(() => f.source.describe());
      const marker = mode === 'async' ? '10be3c10-d67a-4c20-b0fe-7060100fd632' : 'TEST-existing-lineage';
      const writer = new TeamPermanentDeletionIdentity(() => false, {
        teams: join(paths.root, 'claude/teams'), tasks: join(paths.root, 'claude/tasks'),
        appData: join(paths.root, 'app'), backups: join(paths.root, 'backups'),
      });
      const claim = mode === 'async'
        ? await writer.claimIdentityMarker(f.teamName, marker, true)
        : writer.claimIdentityMarkerSync(f.teamName, marker);
      expect(claim).toEqual({ status: 'owned', identityId: marker });
      const bytes = readFileSync(f.configPath, 'utf8');
      const config = JSON.parse(bytes) as typeof f.config;
      expect(config._backupIdentityId).toBe(marker);
      const records = { config, meta: f.meta, roster: f.roster };
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('empty');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.sourceRevision).not.toBe(initial.sourceRevision);
      expect(header.savedSettings).not.toHaveProperty('_backupIdentityId');
      expect(header.members.map(member => member.name)).toEqual(['team-lead', 'worker']);
      expect(await writer.claimIdentityMarker(f.teamName, 'TEST-other-incarnation', true))
        .toEqual({ status: 'different', identityId: marker });
      expect((await f.source.fenced(() => f.source.describe())).sourceRevision).toBe(header.sourceRevision);
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
      f.owners.provisioning.readStoppedTeamImportRuntimeFacts = () => ({ active: 1 });
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'owner-active' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  );

  it('refuses malformed or foreign backup identity fields without rewriting saved records', async () => {
    const f = await stoppedOpenCodeConfig();
    const variants = [
      ...['', ' ', ' padded', 'padded ', 'bad\0identity', null, false, 1, {}, [], 'x'.repeat(256 * 1024 + 1)]
        .map(_backupIdentityId => ({ ...f.config, _backupIdentityId })),
      { ...f.config, _backupIdentityId: 'TEST-identity', unknownBackupAuthority: true },
    ];
    for (const config of variants) {
      const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes);
      expect(isLegacySavedTeamProductRecords(f.teamName, { config, meta: f.meta, roster: f.roster })).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'source-unreadable' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it('keeps native release requirements with a valid backup identity marker', async () => {
    const f = await stoppedOpenCodeConfig();
    for (const fields of [{ leadSessionId: 'TEST-native-session' }, { sessionHistory: ['TEST-native-session'] }]) {
      const config = { ...f.config, _backupIdentityId: 'TEST-identity', ...fields };
      const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes);
      const records = { config, meta: f.meta, roster: f.roster };
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('retained');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'native-custody-unverified' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it.each(['post-launch', 'project-path'] as const)(
    'reads actual maintenance %s writer output at its 500-path bound', async mode => {
      const f = await maintainedOpenCodeConfig(mode);
      const before = readFileSync(f.configPath, 'utf8');
      expect(f.config.projectPathHistory).toHaveLength(500);
      expect((f.config.projectPathHistory as string[]).at(-1)).toBe(f.meta.cwd);
      if (mode === 'post-launch') expect(f.config).toMatchObject({ language: 'en', sessionHistory: [] });
      else {
        expect(f.config).not.toHaveProperty('language');
        expect(f.config).not.toHaveProperty('sessionHistory');
      }
      const records = { config: f.config, meta: f.meta, roster: f.roster };
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('empty');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(true);
      expect((await f.source.fenced(() => f.source.describe())).members.map(member => member.name))
        .toEqual(['team-lead', 'worker']);
      expect(readFileSync(f.configPath, 'utf8')).toBe(before);
    }
  );

  it('refuses malformed, oversized and unknown maintenance product fields', async () => {
    const f = await maintainedOpenCodeConfig('post-launch');
    const variants = [
      ...[null, 1, {}, [], 'bad\0language', 'x'.repeat(256 * 1024 + 1)].map(language => ({ ...f.config, language })),
      ...[null, 'path', {}, [1], ['bad\0path'], Array(501).fill('/TEST-path')]
        .map(projectPathHistory => ({ ...f.config, projectPathHistory })),
      ...[null, ''].map(sessionHistory => ({ ...f.config, sessionHistory })),
      { ...f.config, unknownMaintenanceField: true },
    ];
    for (const config of variants) {
      const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes);
      expect(isLegacySavedTeamProductRecords(f.teamName, { config, meta: f.meta, roster: f.roster })).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'source-unreadable' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it('retains original native custody requirements for nonempty maintenance session identity', async () => {
    const f = await maintainedOpenCodeConfig('post-launch');
    for (const fields of [{ sessionHistory: ['TEST-native-session'] }, { leadSessionId: 'TEST-native-session' }]) {
      const config = { ...f.config, ...fields };
      const bytes = JSON.stringify(config), records = { config, meta: f.meta, roster: f.roster };
      writeFileSync(f.configPath, bytes);
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('retained');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'native-custody-unverified' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it.each([{ color: '#336699' }, { stopped: true }])(
    'reads the exact OpenCode writer and stopped product shape %j', async (options) => {
      const f = await stoppedOpenCodeConfig(options);
      const before = readFileSync(f.configPath, 'utf8');
      if ('stopped' in options) {
        expect(f.config.members.find(member => member.name === 'worker')).toMatchObject({ isActive: false });
        expect(f.config.members.some(member => 'runtimePid' in member || 'runtimeSessionId' in member)).toBe(false);
      }
      const records = { config: f.config, meta: f.meta, roster: f.roster };
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('empty');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.savedSettings.providerId).toBe('opencode');
      expect(header.members.map(member => member.name)).toEqual(['team-lead', 'worker']);
      expect(readFileSync(f.configPath, 'utf8')).toBe(before);
    }
  );

  it('refuses active or malformed member flags, malformed color and unknown product keys', async () => {
    const f = await stoppedOpenCodeConfig({ stopped: true });
    const variants = [
      ...[true, 'false', 0, null, [], {}].map(isActive => ({ ...f.config,
        members: f.config.members.map(member => member.name === 'worker' ? { ...member, isActive } : member) })),
      ...[null, 1, {}, [], 'bad\0color'].map(color => ({ ...f.config, color })),
      { ...f.config, unknownProductField: true },
      { ...f.config, members: f.config.members.map(member => ({ ...member, unknownProductField: true })) },
    ];
    for (const config of variants) {
      const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes);
      expect(isLegacySavedTeamProductRecords(f.teamName, { config, meta: f.meta, roster: f.roster })).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'source-unreadable' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it('does not let a stopped member flag replace original native custody requirements', async () => {
    const f = await stoppedOpenCodeConfig({ stopped: true });
    for (const [key, value] of [['runtimePid', 12345], ['runtimeSessionId', 'TEST-native-session'],
      ['runId', 'TEST-native-run']] as const) {
      const config = { ...f.config, members: f.config.members.map(member => member.name === 'worker'
        ? { ...member, [key]: value } : member) };
      const bytes = JSON.stringify(config), records = { config, meta: f.meta, roster: f.roster };
      writeFileSync(f.configPath, bytes);
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('retained');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({ reason: 'native-custody-unverified' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(bytes);
    }
  });

  it.each([undefined, 1] as const)(
    'retains runtime selection version %s from the real Save-only writer',
    async (version) => {
      const f = await savedDraft(version);
      expect(f.meta.runtimeSelectionVersion).toBe(version);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, {
          config: null,
          meta: f.meta,
          roster: f.roster,
        })
      ).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.sourceKind).toBe('saved-draft');
      expect(header.savedSettings.runtimeSelectionVersion).toBe(version);
      expect(header.savedSettings).toMatchObject({ providerId: 'codex', model: 'TEST-model' });
      expect(header.members.map((member) => member.name)).toEqual(['team-lead', 'worker']);
      expect(JSON.parse(readFileSync(f.metaPath, 'utf8'))).toEqual(f.meta);
    }
  );

  it('refuses unsupported versions and unrelated fields without normalizing saved records', async () => {
    const f = await savedDraft(1);
    const invalidMetadata = [
      ...[0, 2, '1', true, null, {}, []].map((runtimeSelectionVersion) => ({
        ...f.meta,
        runtimeSelectionVersion,
      })),
      { ...f.meta, launchIdentity: { providerId: 'codex', selectedModelKind: 'explicit' } },
      { ...f.meta, unknownProductField: true },
    ];
    for (const meta of invalidMetadata) {
      const bytes = JSON.stringify(meta);
      writeFileSync(f.metaPath, bytes);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, { config: null, meta, roster: f.roster })
      ).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({
        reason: 'source-unreadable',
      });
      expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
    }
  });

  it.each(
    (['anthropic', 'codex', 'gemini', 'opencode'] as const).flatMap((providerId) =>
      (['default', 'explicit'] as const).map((selectedModelKind) => ({
        providerId,
        selectedModelKind,
      }))
    )
  )(
    'reads the real metadata writer launch identity for $providerId/$selectedModelKind',
    async ({ providerId, selectedModelKind }) => {
      const identity = launchIdentity(providerId, selectedModelKind);
      const f = await savedDraft(1, identity);
      expect(f.meta.launchIdentity).toEqual(identity);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, {
          config: null,
          meta: f.meta,
          roster: f.roster,
        })
      ).toBe(true);
      const header = await f.source.fenced(() => f.source.describe());
      expect(header.sourceKind).toBe('saved-draft');
      expect(header.savedSettings.providerId).toBe(providerId);
      expect(header.savedSettings).not.toHaveProperty('launchIdentity');
      expect(JSON.parse(readFileSync(f.metaPath, 'utf8'))).toEqual(f.meta);
    }
  );

  it('reads older identities without the optional billing and fast-mode fields', async () => {
    const f = await savedDraft(1, launchIdentity('opencode', 'default'));
    const identity = { ...(f.meta.launchIdentity as Record<string, unknown>) };
    for (const key of [
      'billingMode',
      'selectedFastMode',
      'resolvedFastMode',
      'fastResolutionReason',
    ])
      delete identity[key];
    const meta = { ...f.meta, launchIdentity: identity },
      bytes = JSON.stringify(meta);
    writeFileSync(f.metaPath, bytes);
    expect(
      isLegacySavedTeamProductRecords(f.teamName, { config: null, meta, roster: f.roster })
    ).toBe(true);
    expect((await f.source.fenced(() => f.source.describe())).sourceKind).toBe('saved-draft');
    expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
  });

  it('refuses malformed identities and unknown nested fields without rewriting saved bytes', async () => {
    const f = await savedDraft(1, launchIdentity('codex', 'explicit'));
    const identity = f.meta.launchIdentity as Record<string, unknown>;
    const invalid = [
      null,
      [],
      'TEST',
      {},
      { ...identity, providerId: 'foreign' },
      { ...identity, providerId: ['codex'] },
      { ...identity, selectedModelKind: 'auto' },
      { ...identity, selectedModel: 1 },
      { ...identity, providerBackendId: {} },
      { ...identity, catalogSource: 'foreign' },
      { ...identity, catalogSource: ['runtime'] },
      { ...identity, catalogFetchedAt: 1 },
      { ...identity, selectedEffort: 'foreign' },
      { ...identity, selectedEffort: ['high'] },
      { ...identity, resolvedEffort: false },
      { ...identity, selectedFastMode: true },
      { ...identity, selectedFastMode: ['inherit'] },
      { ...identity, resolvedFastMode: 'true' },
      { ...identity, billingMode: 'foreign' },
      { ...identity, billingMode: ['api'] },
      { ...identity, fastResolutionReason: 'bad\0value' },
      { ...identity, unknownProductField: true },
      { ...identity, credentials: { apiKey: 'TEST-only' } },
      Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'selectedModel')),
    ];
    for (const launchIdentity of invalid) {
      const meta = { ...f.meta, launchIdentity },
        bytes = JSON.stringify(meta);
      writeFileSync(f.metaPath, bytes);
      expect(
        isLegacySavedTeamProductRecords(f.teamName, { config: null, meta, roster: f.roster })
      ).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({
        reason: 'source-unreadable',
      });
      expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
    }
  });

  it('keeps nested native identities subject to the original custody requirement', async () => {
    const f = await savedDraft(1, launchIdentity('codex', 'explicit'));
    for (const [key, value] of [
      ['sessionId', 'TEST-native-session'],
      ['runId', 'TEST-native-run'],
      ['pid', process.pid],
    ] as const) {
      const meta = {
        ...f.meta,
        launchIdentity: { ...(f.meta.launchIdentity as Record<string, unknown>), [key]: value },
      };
      const bytes = JSON.stringify(meta),
        records = { config: null, meta, roster: f.roster };
      writeFileSync(f.metaPath, bytes);
      expect(classifyLegacySavedTeamNativeRecords(f.teamName, records)).toBe('retained');
      expect(isLegacySavedTeamProductRecords(f.teamName, records)).toBe(false);
      await expect(f.source.fenced(() => f.source.describe())).rejects.toMatchObject({
        reason: 'native-custody-unverified',
      });
      expect(readFileSync(f.metaPath, 'utf8')).toBe(bytes);
    }
  });
});

function launchIdentity(
  providerId: ProviderModelLaunchIdentity['providerId'],
  selectedModelKind: ProviderModelLaunchIdentity['selectedModelKind']
): ProviderModelLaunchIdentity {
  return {
    providerId,
    providerBackendId: providerId === 'codex' ? 'codex-native' : null,
    billingMode: 'api',
    selectedModel: selectedModelKind === 'explicit' ? 'TEST-model' : null,
    selectedModelKind,
    resolvedLaunchModel: 'TEST-model',
    catalogId: 'TEST-catalog',
    catalogSource: 'runtime',
    catalogFetchedAt: '2026-11-20T00:00:00.000Z',
    selectedEffort: null,
    resolvedEffort: 'high',
    selectedFastMode: 'inherit',
    resolvedFastMode: false,
    fastResolutionReason: null,
  };
}
