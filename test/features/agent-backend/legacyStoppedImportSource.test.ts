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
  FileStoppedTeamImport,
  validateStoppedSnapshot,
} from '@agent-teams/legacy-agent-host/stopped-team-import';
import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureLegacyStoppedSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/captureLegacyStoppedSource';
import {
  createLegacyStoppedTeamSource,
  LegacyStoppedImportHold,
} from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createRetainedLegacyOpenDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createRetainedLegacyOpenDiagnostic';
import { prepareStoppedLegacyImport } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/prepareStoppedLegacyImport';
import { ApplicationCommandRunner } from '../../../src/features/application-command-ledger';
import { MemberWorkSyncTeamOperationGate } from '../../../src/features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { captureLegacySourceReadFence } from '../../../src/features/member-work-sync/main/composition/legacySourceWorkSyncAdmission';
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

import type { StoppedImportPrepareObservation } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createStoppedImportDiagnostic';
import type { RetainedLegacyOpenDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/retainedLegacyOpenDiagnosticContract';
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
  const teamName = 'test-source';
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

function writeEmptyCaughtUpWorkSync(f: ReturnType<typeof fixture>) {
  const timestamp = '2026-11-22T23:43:35.240Z';
  const incarnation = 'TEST-original-work-sync';
  const member = { teamName: f.teamName, memberName: 'team-lead' };
  const fingerprint = 'TEST-empty-agenda';
  const status = {
    ...member,
    state: 'caught_up',
    providerId: 'anthropic',
    evaluatedAt: timestamp,
    diagnostics: ['agenda_empty'],
    agenda: { ...member, generatedAt: timestamp, fingerprint, items: [], diagnostics: [] },
    statusRevision: { incarnation, lineageId: 'TEST-lineage', sequence: 1, nonce: 'TEST-nonce' },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: false,
      fingerprintChanged: false,
      triggerReasons: ['startup_scan'],
    },
  };
  const root = join(f.team, '.member-work-sync');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'report-token-secret.json'),
    JSON.stringify({
      schemaVersion: 2,
      teamName: f.teamName,
      incarnation,
      secret: 'TEST-source-secret'.padEnd(43, 'x'),
    })
  );
  writeFileSync(
    join(root, 'sqlite-fallback-replica.json'),
    JSON.stringify({
      schemaVersion: 1,
      state: 'clean',
      incarnation,
      updatedAt: timestamp,
      snapshot: {
        statuses: [status],
        reportIntents: [],
        outboxItems: [],
        filesToArchive: [],
        metricEvents: [
          {
            ...member,
            id: 'TEST-empty-metric',
            kind: 'status_evaluated',
            state: 'caught_up',
            agendaFingerprint: fingerprint,
            recordedAt: timestamp,
            actionableCount: 0,
          },
        ],
      },
    })
  );
  const journalPath = 'members/team-lead/.member-work-sync/journal.jsonl';
  const journal =
    [
      { event: 'reconcile_started', triggerReasons: ['startup_scan'] },
      {
        event: 'agenda_loaded',
        agendaFingerprint: fingerprint,
        actionableCount: 0,
        diagnostics: [],
      },
      {
        event: 'decision_made',
        agendaFingerprint: fingerprint,
        state: 'caught_up',
        actionableCount: 0,
        diagnostics: ['agenda_empty'],
      },
    ]
      .map((row) =>
        JSON.stringify({ ...member, schemaVersion: 1, timestamp, source: 'reconciler', ...row })
      )
      .join('\n') + '\n';
  mkdirSync(join(f.team, 'members/team-lead/.member-work-sync'), { recursive: true });
  writeFileSync(join(f.team, journalPath), journal);
  return { incarnation, journalPath, journal };
}

describe('actual legacy source owners and existing fences', () => {
  it('distinguishes original unreadable source boundaries without changing refusal or saved bytes', async () => {
    const cases = [
      ['config.json', '{"TEST-private":', 'config-read'],
      ['team.meta.json', { version: 2, cwd: '/TEST/private' }, 'record-shape'],
      ['team.meta.json', { version: 1, cwd: '/TEST/private', credentials: 'TEST-private' }, 'private-configuration'],
      ['team.meta.json', { version: 1, cwd: '/TEST/private', createdAt: 1, unexpected: 'TEST-private' }, 'product-records'],
    ] as const;
    for (const [file, value, sourceBoundary] of cases) {
      const f = fixture();
      const contents = typeof value === 'string' ? value : JSON.stringify(value);
      writeFileSync(join(f.team, file), contents);
      const error = await f.source.fenced(() => f.source.describe()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(LegacyStoppedImportHold);
      expect(error).toMatchObject({ reason: 'source-unreadable', message: 'source-unreadable' });
      expect(Object.hasOwn(error as object, 'sourceBoundary')).toBe(false);
      const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
      const observe = createRetainedLegacyOpenDiagnostic(
        { action: 'open', teamName: f.teamName, intentId: 'TEST-original-source-once' },
        1234,
        sink
      );
      observe.remember('coordinator-admission', error);
      expect(sink).not.toHaveBeenCalled();
      const result = { ok: false, reason: 'not-eligible', outcome: 'not-dispatched' };
      observe.finish('coordinator-admission', result);
      expect(sink).toHaveBeenCalledExactlyOnceWith({
        v: 1,
        mainPid: 1234,
        operationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        phase: 'coordinator-admission',
        category: 'source-unreadable',
        outcome: 'not-dispatched',
        sourceBoundary,
      });
      expect(JSON.stringify(sink.mock.calls)).not.toContain('TEST-private');
      expect(result).toEqual({ ok: false, reason: 'not-eligible', outcome: 'not-dispatched' });
      expect(readFileSync(join(f.team, file), 'utf8')).toBe(contents);
    }
  });

  it('preserves a frozen original Hold and omits boundary for a reused error identity', async () => {
    const f = fixture();
    const original = Object.freeze(new LegacyStoppedImportHold('source-unreadable'));
    const notifications = vi.spyOn(f.data, 'readStoppedTeamImportNotificationFacts')
      .mockRejectedValue(original);
    const observe = (error: unknown) => {
      const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
      const diagnostic = createRetainedLegacyOpenDiagnostic(
        { action: 'open', teamName: f.teamName, intentId: 'TEST-original-source-once' },
        1234,
        sink
      );
      diagnostic.remember('coordinator-admission', error);
      diagnostic.finish('coordinator-admission', { ok: false, reason: 'not-eligible', outcome: 'not-dispatched' });
      return sink.mock.calls[0]![0];
    };
    try {
      const first = await f.source.fenced(() => f.source.describe()).catch((error: unknown) => error);
      expect(first).toBe(original);
      const firstObservation = observe(first);
      expect(firstObservation).toMatchObject({ sourceBoundary: 'notification-facts' });
      const second = await f.source.fenced(() => f.source.describe()).catch((error: unknown) => error);
      expect(second).toBe(original);
      expect(observe(second)).not.toHaveProperty('sourceBoundary');
      expect(observe(first)).not.toHaveProperty('sourceBoundary');
      expect(firstObservation).toMatchObject({ sourceBoundary: 'notification-facts' });
      expect(Object.isFrozen(firstObservation)).toBe(true);
      expect(notifications).toHaveBeenCalledTimes(2);
      expect(Object.hasOwn(original, 'sourceBoundary')).toBe(false);
    } finally {
      notifications.mockRestore();
    }
  });

  it.each([0, 1_761_000_000_000])(
    'preserves removed teammate identity/settings at %s through import, cold read and the existing roster restore',
    async (removedAt) => {
      const f = fixture();
      const retired = {
        name: 'retired-worker',
        role: 'TEST reviewer',
        workflow: 'Retain TEST workflow',
        model: 'TEST-retired-model',
        fastMode: 'off' as const,
        removedAt,
      };
      writeFileSync(
        join(f.team, 'members.meta.json'),
        JSON.stringify({
          version: 1,
          members: [{ name: 'team-lead', agentType: 'team-lead' }, retired],
        })
      );
      const snapshot = await exportStoppedTeam(f.source);
      expect(snapshot.header.removedMembers).toEqual([
        {
          memberId: retired.name,
          name: retired.name,
          role: 'member',
          settings: {
            role: retired.role,
            workflow: retired.workflow,
            model: retired.model,
            fastMode: 'off',
          },
          removedAt: new Date(retired.removedAt).toISOString(),
        },
      ]);
      const destination = join(f.root, 'TEST-destination');
      mkdirSync(destination);
      const importer = new FileStoppedTeamImport({
        root: destination,
        ownerId: 'TEST-host',
        profileId: 'TEST-profile',
        principalId: 'TEST-human',
        contextIds: ['TEST-context'],
        assertWriter() {},
        existingRecords: () => [],
        bindOrigin() {},
        validateConfiguration() {},
        attach() {},
      });
      const receipt = importer.import(
        'TEST-import-original',
        {
          contextId: 'TEST-context',
          sourceId: 'TEST-source-identity',
          snapshotDigest: snapshot.digest,
          teamName: 'TEST-imported',
        },
        snapshot
      );
      expect(receipt.phase).toBe('published');
      const connection = () =>
        createFilesystemTeamOwner({
          root: destination,
          binding: {
            backendId: 'TEST-host',
            teamId: receipt.record.teamId,
            teamName: receipt.record.teamName,
          },
          members: [],
          grants: [],
        }).connect('TEST-human');
      const before = connection().readRoster();
      expect(before.members.map((member) => member.name)).toEqual(['team-lead']);
      expect(before.removedMembers).toEqual(
        snapshot.header.removedMembers!.map(({ role: _role, ...member }) => member)
      );
      const statePath = join(destination, 'teams/TEST-imported/.host-owner/state.json');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).grants).toHaveLength(1);
      connection().replaceRoster({
        commandId: 'TEST-restore-original',
        expectedRevision: before.revision,
        members: before.removedMembers.map((member) => ({ ...member.settings, name: member.name })),
      });
      const restored = connection().readRoster();
      expect(restored.removedMembers).toEqual([]);
      expect(restored.members.find((member) => member.name === retired.name)).toMatchObject({
        memberId: retired.name,
        role: 'member',
        settings: before.removedMembers[0]!.settings,
      });
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.grants).toHaveLength(1);
      expect(
        state.members.every((member: { delivery?: unknown }) => member.delivery === undefined)
      ).toBe(true);
      expect(state.runtimeCaptures).toBeUndefined();
    }
  );
  it.each([false, true])(
    'exports retained native IDs only after original release, with empty caught-up WorkSync=%s',
    async (withWorkSync) => {
      const f = fixture();
      const workSync = withWorkSync ? writeEmptyCaughtUpWorkSync(f) : null;
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
      const config = {
        name: f.teamName,
        ...(workSync ? { _backupIdentityId: workSync.incarnation } : {}),
        leadAgentId: `team-lead@${f.teamName}`,
        leadSessionId: 'TEST-session',
        members: [{ name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' }],
      };
      write('config.json', config);
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
      if (workSync)
        expect(captureLegacyNativeStop(join(f.root, 'claude/teams'), run, () => true)).toBeNull();
      const fence = workSync
        ? captureLegacySourceReadFence(f.teamName, {
            gate: new MemberWorkSyncTeamOperationGate(),
            router: { awaitTeamIdle: async () => {} },
            queue: {
              awaitTeamIdle: async () => {},
              getDiagnostics: () => ({ queuedItems: [], runningItems: [] }),
            },
            audit: { awaitTeamIdle: async () => {} },
          })
        : null;
      const captured = captureLegacyNativeStop(
        join(f.root, 'claude/teams'),
        run,
        () => true,
        fence !== null
      )!;
      expect(captured).not.toBeNull();
      await expect(f.source.describe()).rejects.toMatchObject({
        reason: 'native-custody-unverified',
      });
      recordVerifiedCliProcessRelease(child, [identity]);
      if (fence) expect(captured.complete(fence.assertDrained)).toBeNull();
      await fence?.drain();
      const proof = captured.complete(fence?.assertDrained)!;
      const store = new TeamLaunchStateStore();
      await store.markStopped(f.teamName, await store.beginStop(f.teamName), proof);
      fence?.release();
      expect(readLegacyNativeStopRelease(f.team, f.teamName)).toEqual(proof);
      const snapshot = await exportStoppedTeam(f.source);
      expect(validateStoppedSnapshot(snapshot)).toEqual(snapshot);
      expect(snapshot.header.obligations.custody).toBe('released');
      expect(snapshot.header.members).toMatchObject([{ name: 'team-lead', role: 'lead' }]);
      if (workSync) {
        for (const path of [
          '.member-work-sync/report-token-secret.json',
          '.member-work-sync/sqlite-fallback-replica.json',
        ]) {
          const file = snapshot.files.find(
            (entry) => entry.category === 'team' && entry.path === path
          )!;
          expect(file.disposition).toBe('excluded');
          expect(file).not.toHaveProperty('base64');
        }
        expect(
          snapshot.files.find((entry) => entry.path === workSync.journalPath)?.disposition
        ).toBe('archive');
        const destination = join(f.root, 'TEST-caught-up-import');
        mkdirSync(destination);
        const importer = new FileStoppedTeamImport({
          root: destination,
          ownerId: 'TEST-host',
          profileId: 'TEST-profile',
          principalId: 'TEST-human',
          contextIds: ['TEST-context'],
          assertWriter() {},
          existingRecords: () => [],
          bindOrigin() {},
          validateConfiguration() {},
          attach() {},
        });
        const receipt = importer.import(
          'TEST-caught-up-original',
          {
            contextId: 'TEST-context',
            sourceId: snapshot.header.sourceId,
            snapshotDigest: snapshot.digest,
            teamName: 'TEST-imported',
          },
          snapshot
        );
        expect(receipt.phase).toBe('published');
        const target = join(destination, 'teams/TEST-imported');
        expect(existsSync(join(target, '.member-work-sync'))).toBe(false);
        expect(existsSync(join(target, workSync.journalPath))).toBe(false);
        expect(
          readFileSync(
            join(target, '.host-owner/import/archive/team', workSync.journalPath),
            'utf8'
          )
        ).toBe(workSync.journal);
        expect(readFileSync(join(f.team, workSync.journalPath), 'utf8')).toBe(workSync.journal);
      }
      // The ordinary outer stopped tail may retain the exact receipt, never infer a new one.
      await store.markStopped(f.teamName);
      expect(readLegacyNativeStopRelease(f.team, f.teamName)).toEqual(proof);
      write('config.json', {
        ...config,
        leadSessionId: 'TEST-foreign-session',
      });
      await expect(f.source.describe()).rejects.toMatchObject({
        reason: 'native-custody-unverified',
      });
    }
  );

  it.each([undefined, 'shared', 'per_project'] as const)('imports actual save-only %s service output without native config or lead session', async (projectContextMode) => {
    const f = fixture();
    rmSync(f.team, { recursive: true });
    rmSync(join(f.root, 'claude/tasks', f.teamName), { recursive: true });
    await f.data.createTeamConfig({
      teamName: f.teamName,
      displayName: 'TEST Saved draft',
      ...(projectContextMode ? { projectContextMode } : {}),
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
    expect(snapshot.header.savedSettings.projectContextMode).toBe(projectContextMode ?? 'per_project');
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
  it.each([
    'initial-source-guard',
    'initial-target-guard',
    'source-construction',
    'source-fence-before-callback',
    'source-describe',
    'snapshot-export',
    'final-source-guard',
    'final-target-guard',
    'snapshot-staging',
  ] as const)(
    'records the last entered prepare boundary %s without changing its refusal',
    async (boundary) => {
      const f = fixture(),
        observation: StoppedImportPrepareObservation = {};
      const captured = captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true);
      let current = true;
      const source = { ...captured, isCurrent: () => current && captured.isCurrent() };
      let owners: Parameters<typeof prepareStoppedLegacyImport>[0]['owners'] = f.owners;
      const original = new Error('PRIVATE-original-target-refusal');
      let targetChecks = 0;
      const target = {
        root: join(f.root, 'target'),
        ownerId: 'TEST-host',
        profileId: 'TEST-profile',
        principalId: 'TEST-human',
        contextIds: ['TEST-context'],
        assertCurrent: () => {
          targetChecks++;
          if (
            boundary === 'initial-target-guard' ||
            (boundary === 'final-target-guard' && targetChecks === 2)
          )
            throw original;
        },
      };
      if (boundary !== 'snapshot-staging') mkdirSync(target.root);
      if (boundary === 'initial-source-guard') current = false;
      if (boundary === 'source-construction') source.roots = [];
      if (boundary === 'snapshot-export')
        source.roots = source.roots.filter((root) => root.category !== 'tasks');
      if (boundary === 'source-describe') {
        const path = join(f.team, 'config.json');
        writeFileSync(
          path,
          JSON.stringify({
            ...JSON.parse(readFileSync(path, 'utf8')),
            leadSessionId: 'TEST-retained-native',
          })
        );
      }
      if (boundary === 'source-fence-before-callback' || boundary === 'final-source-guard') {
        owners = {
          ...owners,
          backup: {
            withTeamIdentityFence: async <T>(
              teamName: string,
              read: () => Promise<T>
            ): Promise<T> => {
              if (boundary === 'source-fence-before-callback') throw original;
              const value = await f.owners.backup.withTeamIdentityFence(teamName, read);
              current = false;
              return value;
            },
          },
        };
      }
      const error = await prepareStoppedLegacyImport({
        source,
        owners,
        target,
        destinationTeamName: f.teamName,
        observation,
      }).then(
        () => {
          throw new Error('Expected original prepare refusal');
        },
        (error: unknown) => error
      );
      expect(observation).toEqual({ boundary });
      if (boundary === 'initial-target-guard' || boundary === 'final-target-guard')
        expect(error).toBe(original);
      else if (boundary === 'source-describe')
        expect(error).toMatchObject({ reason: 'native-custody-unverified' });
      else if (boundary === 'source-construction')
        expect(error).toMatchObject({ reason: 'source-unreadable' });
      else if (boundary === 'initial-source-guard' || boundary === 'final-source-guard')
        expect(error).toMatchObject({ reason: 'source-changed' });
      else if (boundary === 'snapshot-staging') expect(error).toMatchObject({ code: 'ENOENT' });
      else expect(error).toMatchObject({ code: 'hold' });
      expect(existsSync(join(target.root, '.host-team-registry'))).toBe(false);
      expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|TEST-/);
    }
  );

  it.each(['frozen', 'setter', 'absent'] as const)(
    'keeps an original authority error with a %s prepare observation slot',
    async (kind) => {
      const f = fixture(),
        original = new Error('PRIVATE-original-authority');
      const observation =
        kind === 'absent'
          ? undefined
          : kind === 'frozen'
            ? Object.freeze({})
            : Object.defineProperty({}, 'boundary', {
                set() {
                  throw new Error('PRIVATE-observer');
                },
              });
      await expect(
        prepareStoppedLegacyImport({
          source: captureLegacyStoppedSource(f.teamName, 'TEST-context', () => true),
          owners: f.owners,
          target: {
            root: '/TEST-must-not-stage',
            ownerId: 'TEST-host',
            profileId: 'TEST-profile',
            principalId: 'TEST-human',
            contextIds: ['TEST-context'],
            assertCurrent() {
              throw original;
            },
          },
          destinationTeamName: f.teamName,
          observation,
        })
      ).rejects.toBe(original);
    }
  );

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
    const configPath = join(f.team, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, language: 'Русский' }));
    const snapshot = await exportStoppedTeam(f.source);
    expect(snapshot.header.removedMembers).toBeUndefined();
    expect(snapshot.header.savedSettings).toMatchObject({
      providerId: 'codex',
      skipPermissions: false,
      fastMode: 'off',
      language: 'Русский',
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
