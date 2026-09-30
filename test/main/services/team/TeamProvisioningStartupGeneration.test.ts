import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { persistDeterministicLaunchMetadata } from '@main/services/team/provisioning/TeamProvisioningLaunchDeterministicSpawnFlow';
import {
  ensureProvisioningTeamDirectory,
  TeamProvisioningRunWriterAuthority,
} from '@main/services/team/provisioning/TeamProvisioningRunWriterAuthority';
import { repairStaleTaskActivityIntervalsOnce } from '@main/services/team/provisioning/TeamProvisioningTaskActivityRepair';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupAuthority() {
  const root = await mkdtemp(join(tmpdir(), 'startup-generation-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation)
  );
  return { root, owner, authority };
}

function pause() {
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { gate, ready, resume: () => resume(), entered: () => entered() };
}

it('fences real launch metadata resumed while authority.start is pending', async () => {
  const { root, owner, authority } = await setupAuthority();
  const teamName = 'generation-reuse';
  const teamPath = join(root, 'teams', teamName);
  const run = { teamName, runId: 'run-A' };
  const membersMetaStore = new TeamMembersMetaStore();
  const teamMetaStore = new TeamMetaStore();
  const paused = pause();
  const members = [{ name: 'old-A-member', role: 'builder' }];
  await mkdir(teamPath, { recursive: true });
  await writeFile(
    join(teamPath, 'config.json'),
    JSON.stringify({ name: teamName, _backupIdentityId: 'original-A' })
  );
  try {
    const start = authority.start(
      teamName,
      () => undefined,
      async (report) => {
        report({
          ...run,
          state: 'validating',
          message: 'waiting on runtime setup',
          startedAt: '',
          updatedAt: '',
        });
        paused.entered();
        await paused.gate;
        await persistDeterministicLaunchMetadata(
          {
            request: { teamName, cwd: root },
            syntheticRequest: { teamName, cwd: root, members },
            launchIdentity: null,
            allEffectiveMemberSpecs: members,
            configuredMemberSpecs: members,
          },
          { membersMetaStore, teamMetaStore, nowMs: () => 123 }
        );
        return { runId: run.runId, launchStatus: 'started' };
      }
    );
    await paused.ready;
    await rename(teamPath, join(root, 'teams', 'original-A'));
    await mkdir(teamPath);
    await writeFile(
      join(teamPath, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: 'replacement-C' })
    );
    await membersMetaStore.writeMembers(teamName, [{ name: 'replacement-C-member' }]);
    paused.resume();
    await expect(start).rejects.toThrow(
      'operator_required: provisioning run writer authority expired'
    );
    expect((await membersMetaStore.getMembers(teamName)).map((member) => member.name)).toEqual([
      'replacement-C-member',
    ]);
    expect(await teamMetaStore.getMeta(teamName)).toBeNull();
    expect(
      JSON.parse(await readFile(join(teamPath, 'config.json'), 'utf8'))._backupIdentityId
    ).toBe('replacement-C');
  } finally {
    paused.resume();
    authority.cleaned(run);
    owner.dispose();
  }
});

it('does not adopt a same-name team created before a pending new-team startup creates its directory', async () => {
  const { root, owner, authority } = await setupAuthority();
  const teamName = 'new-team-reused-before-create';
  const teamPath = join(root, 'teams', teamName);
  const run = { teamName, runId: 'run-A' };
  const roster = new TeamMembersMetaStore();
  const paused = pause();
  try {
    const start = authority.start(
      teamName,
      () => undefined,
      async (report) => {
        report({
          ...run,
          state: 'validating',
          message: 'waiting on setup',
          startedAt: '',
          updatedAt: '',
        });
        paused.entered();
        await paused.gate;
        await ensureProvisioningTeamDirectory(teamName);
        await roster.writeMembers(teamName, [{ name: 'old-A-member' }]);
        return { runId: run.runId, launchStatus: 'started' };
      }
    );
    await paused.ready;
    await mkdir(teamPath, { recursive: true });
    await writeFile(
      join(teamPath, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: 'replacement-C' })
    );
    await roster.writeMembers(teamName, [{ name: 'replacement-C-member' }]);
    paused.resume();
    await expect(start).rejects.toThrow(
      'operator_required: provisioning run writer authority expired'
    );
    expect((await roster.getMembers(teamName)).map((member) => member.name)).toEqual([
      'replacement-C-member',
    ]);
  } finally {
    paused.resume();
    authority.cleaned(run);
    owner.dispose();
  }
});

it('fences new-team writes after its directory was created and then replaced', async () => {
  const { root, owner, authority } = await setupAuthority();
  const teamName = 'new-team-reused-after-create';
  const teamPath = join(root, 'teams', teamName);
  const run = { teamName, runId: 'run-A' };
  const roster = new TeamMembersMetaStore();
  const paused = pause();
  try {
    const start = authority.start(
      teamName,
      () => undefined,
      async (report) => {
        report({ ...run, state: 'validating', message: 'creating', startedAt: '', updatedAt: '' });
        await ensureProvisioningTeamDirectory(teamName);
        await roster.writeMembers(teamName, [{ name: 'old-A-member' }]);
        paused.entered();
        await paused.gate;
        await roster.updateMembers(teamName, (members) => [...members, { name: 'late-A-member' }]);
        return { runId: run.runId, launchStatus: 'started' };
      }
    );
    await paused.ready;
    await rename(teamPath, join(root, 'teams', 'original-A'));
    await mkdir(teamPath);
    await writeFile(
      join(teamPath, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: 'replacement-C' })
    );
    await roster.writeMembers(teamName, [{ name: 'replacement-C-member' }]);
    paused.resume();
    await expect(start).rejects.toThrow(
      'operator_required: provisioning run writer authority expired'
    );
    expect((await roster.getMembers(teamName)).map((member) => member.name)).toEqual([
      'replacement-C-member',
    ]);
  } finally {
    paused.resume();
    authority.cleaned(run);
    owner.dispose();
  }
});

it('captures a fresh deterministic team before crash repair creates its board lock', async () => {
  const { root, owner, authority } = await setupAuthority();
  const teamName = 'fresh-deterministic-create';
  const run = { teamName, runId: 'run-deterministic-create' };
  const teamMetaStore = new TeamMetaStore();
  try {
    await expect(
      authority.start(teamName, () => undefined, async () => {
        expect(
          repairStaleTaskActivityIntervalsOnce(teamName, null, {
            taskActivityIntervalService: new TeamTaskActivityIntervalService(),
            tracking: { repairedTeams: new Set(), pendingSnapshots: new Map() },
          })
        ).toBe(true);
        await ensureProvisioningTeamDirectory(teamName);
        await teamMetaStore.writeMeta(teamName, { cwd: root, createdAt: 123 });
        return { runId: run.runId, launchStatus: 'started' };
      })
    ).resolves.toEqual({ runId: run.runId, launchStatus: 'started' });
    expect((await teamMetaStore.getMeta(teamName))?.cwd).toBe(root);
  } finally {
    authority.cleaned(run);
    owner.dispose();
  }
});
