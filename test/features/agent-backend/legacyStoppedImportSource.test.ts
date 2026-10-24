// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exportStoppedTeam,
  validateStoppedSnapshot,
} from '@agent-teams/legacy-agent-host/stopped-team-import';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureLegacyStoppedSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/captureLegacyStoppedSource';
import { createLegacyStoppedTeamSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { prepareStoppedLegacyImport } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/prepareStoppedLegacyImport';
import { ApplicationCommandRunner } from '../../../src/features/application-command-ledger';
import { TaskBoardCommandFacade } from '../../../src/features/task-board-commands';
import { isLegacySavedTeamProductRecords } from '../../../src/main/services/team/LegacySavedTeamNativeIdentity';
import {
  captureLegacyNativeStop,
  readLegacyNativeStopRelease,
} from '../../../src/main/services/team/provisioning/LegacyNativeStopRelease';
import { TeamBackupService } from '../../../src/main/services/team/TeamBackupService';
import { TeamDataService } from '../../../src/main/services/team/TeamDataService';
import { TeamLaunchStateStore } from '../../../src/main/services/team/TeamLaunchStateStore';
import { TeamProvisioningService } from '../../../src/main/services/team/TeamProvisioningService';
import {
  recordOwnedUnixProcessGroup,
  recordVerifiedCliProcessRelease,
} from '../../../src/main/utils/cliProcessCustody';

import type {
  ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStore,
} from '../../../src/features/application-command-ledger';
import type { ChildProcess } from 'node:child_process';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-stopped-import' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, 'claude'),
  getTeamsBasePath: () => join(paths.root, 'claude/teams'),
  getTasksBasePath: () => join(paths.root, 'claude/tasks'),
  getAppDataPath: () => join(paths.root, 'app'),
  getBackupsBasePath: () => join(paths.root, 'app/backups'),
}));
// Constructor's automatic stale credential cleanup is outside this read-only fixture.
vi.mock(
  '../../../src/main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperCleanup',
  () => ({
    createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner: () => ({
      start() {},
      stop() {},
      getPendingTeamNames: () => [],
      hasPendingCleanup: () => false,
    }),
  })
);
class FixtureProvisioning extends TeamProvisioningService {
  markPending(team: string) {
    this.provisioningRunByTeam.set(team, 'TEST-pending');
  }
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-legacy-stopped-source-')));
  roots.push(root);
  paths.root = root;
  const teamName = 'TEST-source';
  const selectedRoots = [
    { category: 'team' as const, path: join(root, 'claude/teams', teamName) },
    { category: 'tasks' as const, path: join(root, 'claude/tasks', teamName) },
    { category: 'attachments' as const, path: join(root, 'app/attachments', teamName) },
    { category: 'task-attachments' as const, path: join(root, 'app/task-attachments', teamName) },
    { category: 'history' as const, path: join(root, 'history') },
    { category: 'evidence' as const, path: join(root, 'evidence') },
  ];
  for (const item of selectedRoots) mkdirSync(item.path, { recursive: true });
  const team = selectedRoots[0]!.path;
  writeFileSync(
    join(team, 'config.json'),
    JSON.stringify({ name: teamName, members: [{ name: 'team-lead', agentType: 'team-lead' }] })
  );
  writeFileSync(
    join(team, 'team.meta.json'),
    JSON.stringify({
      version: 1,
      cwd: '/TEST/workspace',
      skipPermissions: false,
      providerId: 'codex',
      fastMode: 'off',
      createdAt: 1,
    })
  );
  writeFileSync(
    join(team, 'members.meta.json'),
    JSON.stringify({
      version: 1,
      members: [{ name: 'team-lead', agentType: 'team-lead', model: 'TEST-model' }],
    })
  );
  const provisioning = new FixtureProvisioning(),
    data = new TeamDataService(),
    backup = new TeamBackupService();
  const records: ApplicationCommandLedgerRecord[] = [];
  const never = async (): Promise<never> => {
    throw new Error('TEST-query-must-not-write');
  };
  const ledger: ApplicationCommandLedgerStore = {
    begin: never,
    markCompleted: never,
    markFailed: never,
    getByCommandId: async () => null,
    getByIdempotencyKey: async () => null,
    listByScope: async () => records as never,
  };
  data.setTaskBoardCommandFacade(
    new TaskBoardCommandFacade(
      new ApplicationCommandRunner({
        ledger,
        hasher: { hashJson: () => '', hashString: () => '' },
      }),
      { isDurableStorageAvailable: async () => true }
    )
  );
  let current = true;
  const source = createLegacyStoppedTeamSource(
    {
      sourceOwnerId: 'TEST-legacy-owner',
      sourceId: 'TEST-source-identity',
      contextId: 'TEST-context',
      teamName,
      roots: selectedRoots,
      isCurrent: () => current,
    },
    { backup, data, provisioning, launch: new TeamLaunchStateStore() }
  );
  return {
    root,
    teamName,
    team,
    source,
    provisioning,
    data,
    records,
    owners: { backup, data, provisioning, launch: new TeamLaunchStateStore() },
    revoke: () => {
      current = false;
    },
  };
}

describe('actual legacy source owners and existing fences', () => {
  it('exports retained native IDs only after the original private process release is durably bound by the actual stopped store', async () => {
    const f = fixture();
    const write = (file: string, value: unknown) =>
      writeFileSync(join(f.team, file), JSON.stringify(value));
    const child = { pid: 44107 } as ChildProcess;
    const identity = {
      pid: child.pid!,
      parentPid: 1,
      processGroupId: child.pid!,
      startIdentity: 'TEST-original-birth',
    };
    recordOwnedUnixProcessGroup(child, identity);
    write('config.json', {
      name: f.teamName,
      leadAgentId: `team-lead@${f.teamName}`,
      leadSessionId: 'TEST-session',
      members: [{ name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' }],
    });
    write('members.meta.json', { version: 1, members: [] });
    write('team.meta.json', {
      version: 1,
      cwd: '/TEST/workspace',
      providerId: 'anthropic',
      createdAt: 1,
    });
    write('launch-state.json', {
      version: 2,
      teamName: f.teamName,
      publicationRunId: 'TEST-run',
      leadSessionId: 'TEST-session',
      expectedMembers: [],
      members: {},
    });
    write('launch-freshness.json', {
      version: 1,
      teamName: f.teamName,
      kind: 'launch',
      runId: 'TEST-run',
    });
    const run = {
      teamName: f.teamName,
      runId: 'TEST-run',
      child,
      detectedSessionId: 'TEST-session',
      expectedMembers: [],
      allEffectiveMembers: [],
      mixedSecondaryLanes: [],
      request: { providerId: 'anthropic', members: [] },
    };
    const captured = captureLegacyNativeStop(join(f.root, 'claude/teams'), run, () => true)!;
    expect(captured).not.toBeNull();
    await expect(f.source.describe()).rejects.toMatchObject({
      reason: 'native-custody-unverified',
    });
    recordVerifiedCliProcessRelease(child, [identity]);
    const proof = captured.complete()!;
    const store = new TeamLaunchStateStore();
    await store.markStopped(f.teamName, await store.beginStop(f.teamName), proof);
    expect(readLegacyNativeStopRelease(f.team, f.teamName)).toEqual(proof);
    const snapshot = await exportStoppedTeam(f.source);
    expect(validateStoppedSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.header.obligations.custody).toBe('released');
    expect(snapshot.header.members).toMatchObject([{ name: 'team-lead', role: 'lead' }]);
    // The ordinary outer stopped tail may retain the exact receipt, never infer a new one.
    await store.markStopped(f.teamName);
    expect(readLegacyNativeStopRelease(f.team, f.teamName)).toEqual(proof);
    write('config.json', {
      name: f.teamName,
      leadSessionId: 'TEST-foreign-session',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    });
    await expect(f.source.describe()).rejects.toMatchObject({
      reason: 'native-custody-unverified',
    });
  });

  it('imports actual save-only service output without manufacturing a native config or lead session', async () => {
    const f = fixture();
    rmSync(f.team, { recursive: true });
    rmSync(join(f.root, 'claude/tasks', f.teamName), { recursive: true });
    await f.data.createTeamConfig({
      teamName: f.teamName,
      displayName: 'TEST Saved draft',
      cwd: '/TEST/workspace',
      providerId: 'anthropic',
      model: 'TEST-draft-model',
      members: [{ name: 'alice', role: 'TEST saved role' }],
    });
    expect(existsSync(join(f.team, 'config.json'))).toBe(false);
    const before = readFileSync(join(f.team, 'members.meta.json'));
    const snapshot = await exportStoppedTeam(f.source);
    expect(validateStoppedSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.header.sourceKind).toBe('saved-draft');
    expect(snapshot.header.savedSettings).toMatchObject({ displayName: 'TEST Saved draft' });
    expect(snapshot.header.members).toMatchObject([
      { name: 'team-lead', role: 'lead', settings: { model: 'TEST-draft-model' } },
      { name: 'alice', role: 'member', settings: { role: 'TEST saved role' } },
    ]);
    expect(readFileSync(join(f.team, 'members.meta.json'))).toEqual(before);
    expect(existsSync(join(f.team, 'config.json'))).toBe(false);
  });
  it('accepts only exact roster-bound product agent keys and holds physical or foreign identities', async () => {
    const f = fixture();
    const config = {
      name: f.teamName,
      leadAgentId: `team-lead@${f.teamName}`,
      members: [{ name: 'team-lead', agentType: 'team-lead', agentId: `team-lead@${f.teamName}` }],
    };
    writeFileSync(join(f.team, 'config.json'), JSON.stringify(config));
    await expect(f.source.describe()).resolves.toMatchObject({ sourceTeamName: f.teamName });
    for (const fields of [
      { leadAgentId: 'team-lead@TEST-other-team' },
      { leadSessionId: 'TEST-real-native-session' },
      { extra: { agentId: `team-lead@${f.teamName}` } },
    ]) {
      writeFileSync(join(f.team, 'config.json'), JSON.stringify({ ...config, ...fields }));
      await expect(f.source.describe()).rejects.toMatchObject({
        reason: 'native-custody-unverified',
      });
    }
  });
  it('rejects duplicate product member names in either metadata or configured roster', () => {
    const f = fixture();
    const config = JSON.parse(readFileSync(join(f.team, 'config.json'), 'utf8'));
    const meta = JSON.parse(readFileSync(join(f.team, 'team.meta.json'), 'utf8'));
    const roster = { version: 1, members: [{ name: 'team-lead' }, { name: 'team-lead' }] };
    expect(isLegacySavedTeamProductRecords(f.teamName, { config, meta, roster })).toBe(false);
    expect(
      isLegacySavedTeamProductRecords(f.teamName, {
        config: { ...config, members: [...config.members, ...config.members] },
        meta,
        roster: { version: 1, members: [] },
      })
    ).toBe(false);
  });
  it('holds malformed or native-bearing no-config draft records', async () => {
    const f = fixture();
    rmSync(join(f.team, 'config.json'));
    for (const members of [
      [{ name: 'bad member' }],
      [{ name: 'alice', sessionId: 'TEST-native' }],
    ]) {
      writeFileSync(join(f.team, 'members.meta.json'), JSON.stringify({ version: 1, members }));
      await expect(f.source.describe()).rejects.toMatchObject({
        reason: members[0]!.name === 'alice' ? 'native-custody-unverified' : 'source-unreadable',
      });
    }
  });
  it('retained lead/history native identity and private raw configuration never qualify as empty custody', async () => {
    const f = fixture(),
      path = join(f.team, 'config.json'),
      original = JSON.parse(readFileSync(path, 'utf8'));
    for (const fields of [
      { leadSessionId: 'TEST-native-lead' },
      { sessionHistory: ['TEST-native-history'] },
      { nativeSessionId: 'TEST-native' },
      { credentials: { apiKey: 'TEST-DUMMY-NOT-A-REAL-KEY' } },
      { env: { TEST_API_KEY: 'TEST-DUMMY' } },
    ]) {
      writeFileSync(path, JSON.stringify({ ...original, ...fields }));
      await expect(f.source.describe()).rejects.toMatchObject({
        reason:
          'credentials' in fields || 'env' in fields
            ? 'source-unreadable'
            : 'native-custody-unverified',
      });
      const current = captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true);
      await expect(
        prepareStoppedLegacyImport({
          source: current,
          owners: f.owners,
          target: {
            root: '/TEST-must-not-stage',
            ownerId: 'TEST-host',
            profileId: 'TEST-profile',
            principalId: 'TEST-human',
            contextIds: ['TEST-context'],
            assertCurrent: () => {},
          },
          destinationTeamName: f.teamName,
        })
      ).rejects.toMatchObject({
        reason:
          'credentials' in fields || 'env' in fields
            ? 'source-unreadable'
            : 'native-custody-unverified',
      });
    }
  });
  it('binds the original directory identity rather than mutable content and rejects same-name replacement', () => {
    const f = fixture();
    const original = captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true);
    writeFileSync(join(f.team, 'TEST-new-content.json'), '{}');
    expect(captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true).sourceId).toBe(
      original.sourceId
    );
    renameSync(f.team, `${f.team}-TEST-original`);
    mkdirSync(f.team);
    expect(original.isCurrent()).toBe(false);
    expect(captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true).sourceId).not.toBe(
      original.sourceId
    );
  });
  it('derives closure from real owner maps/ledger scope and preserves exact saved policy without native effects', async () => {
    const f = fixture(),
      before = readFileSync(join(f.team, 'team.meta.json'));
    const snapshot = await exportStoppedTeam(f.source);
    expect(snapshot.header.savedSettings).toMatchObject({
      providerId: 'codex',
      skipPermissions: false,
      fastMode: 'off',
    });
    expect(snapshot.header.members[0]).toMatchObject({
      memberId: 'team-lead',
      settings: { model: 'TEST-model' },
    });
    expect(snapshot.files.find((file) => file.path === 'members.meta.json')!.disposition).toBe(
      'archive'
    );
    expect(readFileSync(join(f.team, 'team.meta.json'))).toEqual(before);
  });
  it('active owner state and missing durable command authority refuse instead of inventing closure', async () => {
    const active = fixture();
    active.provisioning.markPending(active.teamName);
    await expect(active.source.describe()).rejects.toMatchObject({ reason: 'owner-active' });
    const unknown = fixture();
    unknown.data.setTaskBoardCommandFacade(null);
    await expect(unknown.source.describe()).rejects.toMatchObject({ reason: 'command-unknown' });
  });
  it('cold native identity, stopped-display marker, unreadable launch and corrupt saved metadata remain HOLD', async () => {
    for (const state of ['identity', 'stopped', 'unreadable', 'corrupt']) {
      const f = fixture();
      if (state === 'identity')
        writeFileSync(
          join(f.team, 'config.json'),
          JSON.stringify({
            name: f.teamName,
            members: [{ name: 'team-lead', agentType: 'team-lead', sessionId: 'TEST-old-native' }],
          })
        );
      if (state === 'stopped')
        writeFileSync(
          join(f.team, 'launch-stopped.json'),
          JSON.stringify({ version: 1, teamName: f.teamName, stoppedAt: '2026-10-23' })
        );
      if (state === 'unreadable') writeFileSync(join(f.team, 'launch-state.json'), '{');
      if (state === 'corrupt') writeFileSync(join(f.team, 'members.meta.json'), '{');
      await expect(f.source.describe()).rejects.toBeInstanceOf(Error);
    }
  });
  it('source capture holds the actual operation fence against another request until completion', async () => {
    const f = fixture();
    let release!: () => void,
      entered!: () => void,
      otherStarted = false;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const capture = f.source.fenced(async () => {
      entered();
      await barrier;
      return 1;
    });
    await ready;
    const other = f.provisioning.withStoppedTeamImportFence(f.teamName, async () => {
      otherStarted = true;
    });
    await Promise.resolve();
    expect(otherStarted).toBe(false);
    release();
    expect(await capture).toBe(1);
    await other;
    expect(otherStarted).toBe(true);
    f.revoke();
    await expect(f.source.describe()).rejects.toMatchObject({ reason: 'source-changed' });
  });
});
