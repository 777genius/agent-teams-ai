import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberWorkSyncFeature,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import {
  getOpenCodeRuntimePromptMessageIds,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createOpenCodePromptDeliveryLedger } from '../../../../src/main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamKanbanManager } from '../../../../src/main/services/team/TeamKanbanManager';
import { getTeamLaunchStatePath } from '../../../../src/main/services/team/TeamLaunchStateStore';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { killExternalProcessTree } from '../../../../src/main/utils/externalProcessTreeKill';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import {
  createOwnedWorkSyncIdentity,
  type OwnedWorkSyncIdentity,
} from '../../../features/member-work-sync/helpers/createOwnedWorkSyncIdentity';

import {
  FatalWaitError,
  formatProgressDump,
  readMemberWorkSyncOutboxItems,
  waitUntil,
} from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  readInboxMessages,
  waitForOpenCodeLanesStopped,
} from './openCodeLiveTestHarness';

import type { TeamWorkSyncIdentityAccess } from '../../../../src/main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';
import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import type {
  PersistedTeamLaunchSnapshot,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

const liveDescribe = process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' ? describe : describe.skip;
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('Member work sync recovery OpenCode live lifecycle', () => {
  let tempDir: string;
  let feature: MemberWorkSyncFeatureFacade | null;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;
  let identity: TeamWorkSyncIdentityAccess | null;
  let owned: OwnedWorkSyncIdentity | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'member-work-sync-recovery-opencode-lifecycle-')
    );
    await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    setClaudeBasePathOverride(path.join(tempDir, '.claude'));
    feature = null;
    harness = null;
    teamName = null;
    owned = await createOwnedWorkSyncIdentity();
    identity = owned.identity;
  });

  afterEach(async () => {
    if (harness && teamName) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName).catch(() => undefined);
    }
    await feature?.dispose().catch(() => undefined);
    await harness?.dispose().catch(() => undefined);
    await owned?.dispose().catch(() => undefined);
    owned = null;
    identity = null;
    setClaudeBasePathOverride(null);
    const warn = vi.mocked(console.warn);
    if (warn.mock) {
      for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
        const rendered = warn.mock.calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
        if (
          rendered.includes('OpenCode inbox relay failed') ||
          rendered.includes('delivery watchdog relay diagnostics') ||
          rendered.includes('opencode_primary_runtime_not_deliverable')
        ) {
          warn.mock.calls.splice(index, 1);
        }
      }
    }
    if (process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncRecoveryOpenCodeLifecycle.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it('rejects token T1 after delete/recreate of the same live team name (C21/S12)', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const memberName = 'bob';
    const projectPath = await writeSandboxProject(tempDir, 'recreate');
    teamName = `member-work-sync-recovery-opencode-recreate-${Date.now()}`;
    const createFeature = (svc: TeamProvisioningService) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: identity!,
        teamsBasePath: getTeamsBasePath(),
        recoveryAllocation: { enabled: false },
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) => svc.isTeamAlive(name) || svc.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => (teamName ? [teamName] : []),
        queueQuietWindowMs: 1,
      });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel,
      projectPath,
      configureServices: (svc) => {
        feature = createFeature(svc);
        svc.setTeamChangeEmitter((event) => feature!.noteTeamChange(event));
        svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
          feature!.buildRuntimeTurnSettledEnvironment(input)
        );
        return { memberWorkSyncFeature: feature! };
      },
    });

    await launchOpenCodeTeam({
      svc: harness.svc,
      teamName,
      projectPath,
      selectedModel,
      memberName,
    });
    expect(harness.svc.isTeamAlive(teamName)).toBe(true);

    const firstStatus = await feature!.refreshStatus({ teamName, memberName });
    expect(firstStatus.reportToken).toBeTruthy();
    const firstIdentity = await identity!.readCurrent(teamName);
    expect(firstIdentity.status).toBe('identified');
    if (firstIdentity.status !== 'identified') {
      throw new Error('expected identified lifecycle marker before recreate');
    }
    const firstToken = firstStatus.reportToken;
    const firstFingerprint = firstStatus.agenda.fingerprint;
    await feature!.stopAutoResume({ teamName, memberName, reason: 'user_stop' });

    await harness.svc.stopTeam(teamName).catch(() => undefined);
    await waitForOpenCodeLanesStopped(teamName);
    await feature!.prepareTeamDeletion(teamName, firstIdentity.identityId);
    feature!.completeTeamDeletion(teamName);
    await fs.rm(path.join(getTeamsBasePath(), teamName), { recursive: true, force: true });
    feature!.resumeTeam(teamName);

    await launchOpenCodeTeam({
      svc: harness.svc,
      teamName,
      projectPath,
      selectedModel,
      memberName,
    });
    feature!.noteTeamChange({ type: 'config', teamName, detail: 'config.json' });
    const recreated = await feature!.refreshStatus({ teamName, memberName });
    const secondIdentity = await identity!.readCurrent(teamName);
    expect(secondIdentity.status).toBe('identified');
    if (secondIdentity.status !== 'identified') {
      throw new Error('expected identified lifecycle marker after recreate');
    }
    expect(secondIdentity.identityId).not.toBe(firstIdentity.identityId);
    expect(recreated.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(recreated.recoveryHealth?.unresolvedIntentId).toBeUndefined();
    expect(recreated.agenda.fingerprint).toBe(firstFingerprint);
    expect(recreated.reportToken).toBeTruthy();
    expect(recreated.reportToken).not.toBe(firstToken);
    await expect(
      feature!.report({
        teamName,
        memberName,
        state: 'caught_up',
        agendaFingerprint: firstFingerprint,
        reportToken: firstToken,
        source: 'test',
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'invalid_report_token',
    });
  }, 420_000);

  it('keeps the accepted prompt after unknown delivery, feature restart, and teammate PID kill (D02/R06)', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const memberName = 'bob';
    const projectPath = await writeSandboxProject(tempDir, 'crash');
    teamName = `member-work-sync-recovery-opencode-crash-${Date.now()}`;
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
    const createFeature = (svc: TeamProvisioningService) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: identity!,
        teamsBasePath: getTeamsBasePath(),
        recoveryAllocation: { enabled: true },
        recoveryProtocol: { version: 1 },
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) => svc.isTeamAlive(name) || svc.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => (teamName ? [teamName] : []),
        queueQuietWindowMs: 500,
      });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel,
      projectPath,
      timeoutMs: 360_000,
      launchTimeoutMs: 360_000,
      configureServices: (svc) => {
        feature = createFeature(svc);
        svc.setTeamChangeEmitter((event) => feature!.noteTeamChange(event));
        svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
          feature!.buildRuntimeTurnSettledEnvironment(input)
        );
        return { memberWorkSyncFeature: feature! };
      },
    });

    await launchOpenCodeTeam({
      svc: harness.svc,
      teamName,
      projectPath,
      selectedModel,
      memberName,
    });
    expect(harness.svc.isTeamAlive(teamName)).toBe(true);
    const adopted = await identity!.adoptLegacy(teamName);
    expect(adopted.status).toBe('identified');

    await seedOpenCodeShadowReadyMetrics({ teamName, memberName });
    const task = await new TeamDataService().createTask(teamName, {
      subject: `Recovery OpenCode live unknown-delivery canary ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature!.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    await waitUntil(
      async () => {
        const inbox = await readInboxMessages(inboxPath);
        return inbox.some(
          (message) =>
            message.messageKind === 'member_work_sync_nudge' &&
            typeof message.messageId === 'string'
        );
      },
      60_000,
      500
    );
    const firstNudge = [...(await readInboxMessages(inboxPath))]
      .reverse()
      .find(
        (message) =>
          message.messageKind === 'member_work_sync_nudge' && typeof message.messageId === 'string'
      );
    expect(firstNudge?.messageId).toBeTruthy();
    await waitForAcceptedOpenCodeNudge({
      svc: harness.svc,
      teamName,
      memberName,
      messageId: firstNudge!.messageId!,
      timeoutMs: 180_000,
    });

    const messageIdsBefore = await listNudgeMessageIds(inboxPath);
    const promptIdsBefore = await listPromptMessageIds(teamName, firstNudge!.messageId!);
    const recoveryIdsBefore = await listRecoveryIntentKeys(teamName, memberName);
    expect(await hasAcceptedPrompt(teamName, firstNudge!.messageId!)).toBe(true);

    const proof = await feature!.scheduleProofMissingRecovery({
      teamName,
      memberName,
      originalMessageId: firstNudge!.messageId!,
      taskRefs: [{ taskId: task.id, teamName }],
      reason: 'protocol_proof_missing',
    });
    expect(proof.reason === 'scheduled' || proof.reason === 'coalesced_recent').toBe(true);
    expect(proof.intentKey).toBe(`proof-missing:${firstNudge!.messageId}`);
    await feature!.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(inboxPath)).toEqual(expect.arrayContaining(messageIdsBefore));
    expect(await listPromptMessageIds(teamName, firstNudge!.messageId!)).toEqual(promptIdsBefore);
    expect(await hasAcceptedPrompt(teamName, firstNudge!.messageId!)).toBe(true);

    await feature!.dispose();
    feature = createFeature(harness.svc);
    harness.svc.setTeamChangeEmitter((event) => feature!.noteTeamChange(event));
    harness.svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
      feature!.buildRuntimeTurnSettledEnvironment(input)
    );
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });
    await feature.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(inboxPath)).toEqual(expect.arrayContaining(messageIdsBefore));
    expect(await listPromptMessageIds(teamName, firstNudge!.messageId!)).toEqual(promptIdsBefore);
    expect(await hasAcceptedPrompt(teamName, firstNudge!.messageId!)).toBe(true);

    const runtimePids = await readSmokeOwnedRuntimePids(teamName);
    expect(runtimePids.length).toBeGreaterThan(0);
    for (const pid of runtimePids) {
      killSmokeOwnedRuntimePid(pid, teamName, tempDir);
    }
    await waitUntil(async () => runtimePids.every((pid) => !isPidAlive(pid)), 15_000, 250);
    await feature.dispatchDueNudges([teamName]);
    expect(await listNudgeMessageIds(inboxPath)).toEqual(expect.arrayContaining(messageIdsBefore));
    expect(await listPromptMessageIds(teamName, firstNudge!.messageId!)).toEqual(promptIdsBefore);
    expect(await hasAcceptedPrompt(teamName, firstNudge!.messageId!)).toBe(true);
    expect(
      (await listRecoveryIntentKeys(teamName, memberName)).filter(
        (key) => !key.startsWith('proof-missing:')
      )
    ).toEqual(recoveryIdsBefore.filter((key) => !key.startsWith('proof-missing:')));
  }, 420_000);
});

async function writeSandboxProject(tempDir: string, suffix: string): Promise<string> {
  const projectPath = path.join(tempDir, `project-${suffix}`);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    `# Member work sync recovery OpenCode live ${suffix} canary\n\nDisposable sandbox only.\n`,
    'utf8'
  );
  return projectPath;
}

async function launchOpenCodeTeam(input: {
  svc: TeamProvisioningService;
  teamName: string;
  projectPath: string;
  selectedModel: string;
  memberName: string;
}): Promise<void> {
  const progressEvents: TeamProvisioningProgress[] = [];
  await input.svc.createTeam(
    {
      teamName: input.teamName,
      cwd: input.projectPath,
      providerId: 'opencode',
      model: input.selectedModel,
      skipPermissions: true,
      prompt: [
        'Keep launch work minimal.',
        'Do not edit files.',
        'If you receive a task, wait for instructions and do not complete it.',
      ].join(' '),
      members: [
        {
          name: input.memberName,
          role: 'Developer',
          providerId: 'opencode',
          model: input.selectedModel,
        },
      ],
    },
    (progress) => {
      progressEvents.push(progress);
    }
  );
  await waitUntil(async () => {
    const last = progressEvents.at(-1);
    if (last?.state === 'failed') {
      throw new FatalWaitError(formatProgressDump(progressEvents));
    }
    return progressEvents.some((progress) =>
      progress.message.includes('OpenCode team launch is ready')
    );
  }, 240_000);
}

async function seedOpenCodeShadowReadyMetrics(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const metricsPath = path.join(
    getTeamsBasePath(),
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  const startMs = Date.now() - 2 * 60 * 60_000;
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'caught_up',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 0,
            evaluatedAt: new Date(startMs).toISOString(),
            providerId: 'opencode',
          },
        },
        recentEvents: Array.from({ length: 24 }, (_, index) => ({
          id: `seed-status-${index}`,
          teamName: input.teamName,
          memberName: input.memberName,
          kind: 'status_evaluated',
          state: 'caught_up',
          agendaFingerprint: `agenda:v1:seed-${index}`,
          recordedAt: new Date(startMs + index * 6 * 60_000).toISOString(),
          actionableCount: 0,
          providerId: 'opencode',
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function listNudgeMessageIds(inboxPath: string): Promise<string[]> {
  return (await readInboxMessages(inboxPath))
    .filter((message) => message.messageKind === 'member_work_sync_nudge')
    .map((message) => message.messageId)
    .filter((value): value is string => Boolean(value))
    .sort();
}

async function listRecoveryIntentKeys(teamName: string, memberName: string): Promise<string[]> {
  return Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName))
    .map((item) => item.payload?.workSyncIntentKey)
    .filter((value): value is string => Boolean(value))
    .sort();
}

async function waitForAcceptedOpenCodeNudge(input: {
  svc: TeamProvisioningService;
  teamName: string;
  memberName: string;
  messageId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastRelay: Awaited<
    ReturnType<TeamProvisioningService['relayOpenCodeMemberInboxMessages']>
  > | null = null;
  while (Date.now() < deadline) {
    if (await hasAcceptedPrompt(input.teamName, input.messageId)) {
      return;
    }
    lastRelay = await input.svc.relayOpenCodeMemberInboxMessages(input.teamName, input.memberName, {
      onlyMessageId: input.messageId,
      source: 'manual',
      deliveryMetadata: {
        replyRecipient: 'user',
      },
    });
    const delivery = lastRelay.lastDelivery;
    if (lastRelay.failed > 0 && delivery?.responsePending !== true && delivery?.accepted !== true) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (await hasAcceptedPrompt(input.teamName, input.messageId)) {
    return;
  }
  throw new Error(`OpenCode prompt was not accepted: ${JSON.stringify(lastRelay, null, 2)}`);
}

async function hasAcceptedPrompt(teamName: string, inboxMessageId: string): Promise<boolean> {
  const records = await listPromptRecords(teamName, inboxMessageId);
  return records.some(
    (record) =>
      Boolean(record.acceptedAt) ||
      record.status === 'accepted' ||
      getOpenCodeRuntimePromptMessageIds(record).length > 0
  );
}

async function listPromptRecords(
  teamName: string,
  inboxMessageId: string
): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
  const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(() => ({
    lanes: {} as Record<string, { laneId: string }>,
  }));
  const records: OpenCodePromptDeliveryLedgerRecord[] = [];
  for (const laneId of Object.keys(laneIndex.lanes)) {
    const listed = await createOpenCodePromptDeliveryLedger(teamName, laneId, {
      teamsBasePath: getTeamsBasePath(),
    })
      .list()
      .catch(() => []);
    for (const record of listed) {
      if (record.inboxMessageId === inboxMessageId) {
        records.push(record);
      }
    }
  }
  return records;
}

async function listPromptMessageIds(teamName: string, inboxMessageId: string): Promise<string[]> {
  return [
    ...new Set(
      (await listPromptRecords(teamName, inboxMessageId)).flatMap((record) =>
        getOpenCodeRuntimePromptMessageIds(record)
      )
    ),
  ].sort();
}

async function readSmokeOwnedRuntimePids(teamName: string): Promise<number[]> {
  const raw = await fs.readFile(getTeamLaunchStatePath(teamName), 'utf8');
  const snapshot = JSON.parse(raw) as PersistedTeamLaunchSnapshot;
  const pids = new Set<number>();
  for (const member of Object.values(snapshot.members ?? {})) {
    if (
      typeof member.runtimePid === 'number' &&
      Number.isSafeInteger(member.runtimePid) &&
      member.runtimePid > 1 &&
      member.runtimePid !== process.pid
    ) {
      pids.add(member.runtimePid);
    }
  }
  return [...pids];
}

function killSmokeOwnedRuntimePid(pid: number, teamName: string, tempDir: string): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Refusing pid ${pid}`);
  }
  if (!isPidAlive(pid)) {
    return;
  }
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  }).stdout.trim();
  const allowed = [teamName, tempDir, 'opencode', 'bun'];
  if (command && !allowed.some((token) => command.includes(token))) {
    throw new Error(`Refusing to kill pid ${pid}: ${command}`);
  }
  const result = killExternalProcessTree(pid, { signal: 'SIGKILL' });
  if (result.killed.length === 0 && isPidAlive(pid)) {
    throw new Error(`Failed to kill pid ${pid}: ${result.diagnostics.join('; ')}`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
