// @vitest-environment node
/**
 * Real Croner, JSON repository, Main facade and child Host Team ledger.
 * No provider is configured: this verifies admission/recovery and cannot claim
 * native model execution or Desktop acceptance.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { CapturedHostClient, DesktopBackendFeature } from '@features/agent-backend/main';
import { createDesktopHostSchedules } from '@main/composition/createDesktopHostSchedules';
import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { SelectedScheduleDispatcher } from '@main/services/schedule/SelectedScheduleDispatcher';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, expect, it, vi } from 'vitest';

import type { TeamHostProfile } from '@agent-teams/legacy-agent-host/team-host';
import type { DesktopBackendDescriptor } from '@features/agent-backend/main';
import type { ScheduleRun } from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-host-schedules-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['home', 'store', 'tmp', 'workspace', '.claude'])
    await mkdir(join(root, directory));
  setClaudeBasePathOverride(join(root, '.claude'));
  const executable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const hostEntry = await realpath(join(process.cwd(), 'packages/legacy-agent-host/dist/cli.js'));
  const owner = { ownerId: 'TEST-schedule-owner', revision: '1', storageRoot: join(root, 'store'),
    profileId: 'TEST-schedule-profile', protocolVersion: 1 as const, buildId: 'TEST-schedule-build',
    nodeSha256: digest(await readFile(executable)), hostEntrySha256: digest(await readFile(hostEntry)) };
  const teams: TeamHostProfile['teams'] = ['A', 'B'].map(id => ({
    binding: { backendId: owner.ownerId, teamId: 'TEST-team-' + id, teamName: 'test-schedule-' + id },
    scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: 'TEST-team-' + id,
      runId: 'TEST-unopened-' + id, memberId: 'TEST-human', generation: '1' },
    savedSettings: { cwd: join(root, 'workspace'), providerId: 'anthropic',
      prompt: 'TEST original saved instructions', model: 'TEST-model', skipPermissions: false },
    members: [{ memberId: 'TEST-lead-' + id, name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'admin', 'task.write', 'message.write'] }],
  }));
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'TEST-human', owner, teams };
  const profilePath = join(root, 'TEST-profile.json'), profileBytes = JSON.stringify(profile);
  await writeFile(profilePath, profileBytes, { mode: 0o600 });
  const ref = { ownerId: owner.ownerId, revision: owner.revision };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1, defaultOwner: ref,
    owners: [{ ...ref, storageRoot: owner.storageRoot, profile: {
      nodeExecutable: executable, nodeVersion: execFileSync(executable, ['--version'], { env: {}, encoding: 'utf8' }).trim(),
      nodeSha256: owner.nodeSha256, hostEntry, hostEntrySha256: owner.hostEntrySha256,
      profileId: owner.profileId, expectedBuildId: owner.buildId, cwd: root,
      env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
        LEGACY_AGENT_HOST_PROFILE_SHA256: digest(profileBytes) },
      startupTimeoutMs: 5000, requestTimeoutMs: 5000, writeTimeoutMs: 1000, shutdownTimeoutMs: 3000,
    } }],
    handles: teams.map((team, index) => ({ handleId: 'TEST-handle-' + index, owner: ref,
      contextId: index ? 'TEST-B' : 'TEST-A', label: team.binding.teamName,
      members: [{ memberId: team.members[0]!.memberId, label: 'team-lead' }], scope: team.scope })),
  };
  const descriptorPath = join(root, 'TEST-descriptor.json'), descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  let foreground = 'TEST-A';
  let feature: DesktopBackendFeature;
  const open = () => {
    feature = new DesktopBackendFeature({ descriptor: { path: descriptorPath, sha256: digest(descriptorBytes) },
      bindingDirectory: join(root, 'bindings') });
    const captured = feature;
    cleanups.push(async () => { await captured.shutdown(); });
    return feature;
  };
  open();
  const scope = { get feature() { return feature; }, selected: true,
    captureSelection: () => { const contextId = foreground; return { contextId, isCurrent: () => foreground === contextId }; },
    captureSender: () => foreground };
  const host = createDesktopHostSchedules(() => scope);
  const repository = new JsonScheduleRepository();
  const forbidden = () => { throw new Error('TEST forbidden legacy fallback'); };
  const dispatcher = new SelectedScheduleDispatcher(
    { assertCanSchedule: async () => forbidden(), dispatch: async () => forbidden() },
    async (scheduleId, runId) => (await repository.listRuns(scheduleId)).filter(row => row.id !== runId),
    host
  );
  const scheduler = new SchedulerService(repository,
    { execute: async () => forbidden(), cancel: () => false, cancelAll() {} },
    async () => forbidden(), dispatcher);
  cleanups.push(() => scheduler.stop());
  await scheduler.start();
  const teamName = hostTeamSelectionKey('TEST-handle-0');
  const capture = () => host.capture({} as IpcMainInvokeEvent, teamName);
  const input = (cronExpression = '0 9 * * 1-5') => ({ teamName, cronExpression, timezone: 'UTC',
    executionMode: 'team' as const, taskFirst: true as const, reviewedSavedPrompt: true as const,
    warmUpMinutes: 0, launchConfig: { cwd: join(root, 'workspace'), prompt: 'TEST scheduled work',
      providerId: 'anthropic' as const } });
  const snapshot = (handleId = 'TEST-handle-0') => feature.facade.invoke({
    handle: { handleId }, operation: 'team.snapshot', commandId: randomUUID(), payload: {},
  });
  async function waitRun(scheduleId: string, predicate: (row: ScheduleRun) => boolean) {
    await vi.waitFor(async () => {
      const latest = await repository.getLatestRun(scheduleId);
      expect(latest && predicate(latest)).toBe(true);
    }, { timeout: 8000 });
    return (await repository.getLatestRun(scheduleId))!;
  }
  return { scheduler, repository, capture, input, snapshot, waitRun,
    switchForeground: (value: string) => { foreground = value; },
    async restart() { await scheduler.stop(); await feature.shutdown(); open(); await scheduler.start(); },
    roster: () => feature.facade.invoke({ handle: { handleId: 'TEST-handle-0' },
      operation: 'team.roster.read', commandId: randomUUID(), payload: {} }),
  };
}

it('carries a lost task-create acknowledgement through cold readback without a duplicate or foreground redirect', async () => {
  const f = await fixture();
  const schedule = await f.scheduler.createSchedule(f.input(), await f.capture());
  const original = CapturedHostClient.prototype.request;
  let created = 0;
  const spy = vi.spyOn(CapturedHostClient.prototype, 'request').mockImplementation(async function (
    this: CapturedHostClient, method, params, options
  ) {
    const result = await original.call(this, method, params, options);
    if (method === 'team.execute' && params && typeof params === 'object' &&
      'payload' in params && params.payload && typeof params.payload === 'object' &&
      'operation' in params.payload && params.payload.operation === 'task.create') {
      created++;
      throw new Error('TEST response lost after actual Host commit');
    }
    return result;
  });
  f.switchForeground('TEST-B');
  const first = await f.scheduler.triggerNow(schedule.id);
  const pending = await f.waitRun(schedule.id, row => row.status === 'skipped');
  expect(pending).toMatchObject({ id: first.id, hostTarget: schedule.hostTarget, pendingTaskCommandId: first.id });
  expect(created).toBe(1);
  expect(await f.snapshot()).toMatchObject({ ok: true, value: {
    tasks: [{ owner: 'team-lead', status: 'pending', subject: 'TEST scheduled work' }] } });
  expect(await f.snapshot('TEST-handle-1')).toMatchObject({ ok: true, value: { tasks: [] } });
  spy.mockRestore();
  await f.restart();
  await f.scheduler.triggerNow(schedule.id);
  const recovered = await f.waitRun(schedule.id, row => row.id !== first.id && row.status === 'skipped');
  expect(recovered.linkedTaskId).toBeTruthy();
  expect(recovered.summary).toContain('Previous task');
  // Bounded history must retain the outstanding task even after its original run is pruned.
  await f.repository.pruneOldRuns(schedule.id, 1);
  await vi.waitFor(() => f.scheduler.triggerNow(schedule.id));
  const next = await f.waitRun(schedule.id, row => row.id !== recovered.id && row.status === 'skipped');
  expect(next.linkedTaskId).toBe(recovered.linkedTaskId);
  expect(await f.snapshot()).toMatchObject({ ok: true, value: { tasks: [expect.any(Object)] } });
  expect(await f.roster()).toMatchObject({ ok: true, value: { savedSettings: { prompt: 'TEST original saved instructions' } } });
}, 20000);

it('runs the actual cron against the captured team and keeps an unavailable launch quiet and recoverable', async () => {
  const f = await fixture();
  const schedule = await f.scheduler.createSchedule(f.input('*/1 * * * * *'), await f.capture());
  f.switchForeground('TEST-B');
  const first = await f.waitRun(schedule.id, row => row.status === 'skipped' && Boolean(row.linkedTaskId));
  await f.scheduler.pauseSchedule(schedule.id);
  expect(first.summary).toContain('team launch failed');
  expect((await f.scheduler.getSchedule(schedule.id))?.status).toBe('paused');
  expect(await f.snapshot()).toMatchObject({ ok: true, value: {
    tasks: [{ status: 'pending', owner: 'team-lead' }] } });
  expect(await f.snapshot('TEST-handle-1')).toMatchObject({ ok: true, value: { tasks: [] } });
  await f.restart();
  expect((await f.scheduler.getSchedule(schedule.id))?.status).toBe('paused');
  await f.scheduler.resumeSchedule(schedule.id);
  const resumed = await f.waitRun(schedule.id, row => row.id !== first.id && row.status === 'skipped');
  expect(resumed.linkedTaskId).toBe(first.linkedTaskId);
  await f.scheduler.deleteSchedule(schedule.id);
  expect(await f.scheduler.getSchedule(schedule.id)).toBeNull();
  expect(await f.snapshot()).toMatchObject({ ok: true, value: { tasks: [expect.any(Object)] } });
}, 20000);

it('reserves the occurrence before slow persistence and drains it on Quit without admitting Host effects', async () => {
  const f = await fixture();
  const schedule = await f.scheduler.createSchedule(f.input(), await f.capture());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.repository.saveRun.bind(f.repository);
  vi.spyOn(f.repository, 'saveRun').mockImplementationOnce(async run => {
    entered();
    await held;
    await original(run);
  });
  const trigger = f.scheduler.triggerNow(schedule.id);
  const rejected = expect(trigger).rejects.toThrow('Scheduler stopped before dispatch');
  await started;
  await expect(f.scheduler.triggerNow(schedule.id)).rejects.toThrow('already has an active run');
  let stopped = false;
  const stopping = f.scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await rejected;
  await stopping;
  expect(await f.snapshot()).toMatchObject({ ok: true, value: { tasks: [] } });
  await f.restart();
  expect((await f.repository.getLatestRun(schedule.id))?.status).toBe('failed_interrupted');
  expect(await f.snapshot()).toMatchObject({ ok: true, value: { tasks: [] } });
}, 20000);
