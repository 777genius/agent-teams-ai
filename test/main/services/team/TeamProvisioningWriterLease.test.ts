import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamProvisioningRunWriterAuthority } from '@main/services/team/provisioning/TeamProvisioningRunWriterAuthority';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('times out deletion preparation without releasing an in-flight provisioning writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-drain-timeout-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'provisioning-timeout-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const provider = owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => {
    entered();
    await gate;
  });
  try {
    await ready;
    const deletion = owner.beginPermanentDeletion(teamName);
    await expect(deletion).rejects.toThrow('operator_required: team writers did not quiesce');
    await expect(owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => 'still-owned'))
      .resolves.toBe('still-owned');
  } finally {
    release();
    await provider.catch(() => undefined);
    owner.dispose();
  }
}, 35_000);

it('drains a provisioning provider call outside the identity lock before the deletion boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-lease-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'provisioning-lease-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const provider = owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => {
    entered();
    await gate;
  });
  try {
    await ready;
    const fence = await Promise.race([
      owner.withTeamIdentityFence(teamName, async () => 'available'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('identity lock held by provider')), 1_000)),
    ]);
    expect(fence).toBe('available');

    let prepared = false;
    const deletion = owner.beginPermanentDeletion(teamName).then((intent) => {
      prepared = true;
      return intent;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prepared).toBe(false);
    await expect(owner.workSyncIdentity.readCurrent(teamName))
      .resolves.toEqual({ status: 'deleting' });
    await expect(owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => undefined))
      .rejects.toThrow('operator_required: team writer admission closed');
    release();
    const intent = await deletion;
    expect(intent.phase).toBe('prepared');
    await expect(owner.workSyncIdentity.readCurrent(teamName))
      .resolves.toEqual({ status: 'deleting' });
    await owner.commitPermanentDeletionBoundary(intent);
    await expect(owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => undefined))
      .rejects.toThrow('operator_required: team writer admission closed');
  } finally {
    release();
    await provider.catch(() => undefined);
    owner.dispose();
  }
});

it('keeps a spawned run and its queued persistence under real deletion authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-run-lease-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'run-lease-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation));
  const run = { teamName, runId: 'run-1' };
  try {
    await authority.start(teamName, () => undefined, async (report) => {
      report({ ...run, state: 'spawning', message: 'started', startedAt: '', updatedAt: '' });
      return { runId: run.runId, launchStatus: 'started' };
    });
    authority.assertCurrent(run);
    let prepared = false;
    const deletion = owner.beginPermanentDeletion(teamName).then((intent) => {
      prepared = true;
      return intent;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prepared).toBe(false);
    await expect(Promise.race([
      owner.withTeamIdentityFence(teamName, () => Promise.resolve('available')),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('run held identity lock')), 1_000)),
    ])).resolves.toBe('available');
    await authority.persistForRun(run, () => writeFile(join(teamPath, 'cleanup.json'), 'settled'));
    expect(await readFile(join(teamPath, 'cleanup.json'), 'utf8')).toBe('settled');
    await expect(owner.workSyncIdentity.withWriterWorkflowLease(teamName, async () => undefined))
      .rejects.toThrow('operator_required: team writer admission closed');
    authority.cleaned(run);
    const intent = await deletion;
    expect(intent.phase).toBe('prepared');
    await owner.commitPermanentDeletionBoundary(intent);
    await rename(teamPath, join(root, 'teams', 'held-a'));
    await mkdir(teamPath);
    await writeFile(join(teamPath, 'config.json'), JSON.stringify({
      name: teamName, _backupIdentityId: 'replacement-c',
    }));
    await expect(authority.persistForRun(run, () => writeFile(join(teamPath, 'stale.json'), 'late')))
      .rejects.toThrow('operator_required: provisioning run writer authority expired');
    expect(await readFile(join(teamPath, 'config.json'), 'utf8')).toContain('replacement-c');
  } finally {
    authority.cleaned(run);
    owner.dispose();
  }
});

it('drains an already entered process-close write after run cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-close-drain-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'close-drain-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation));
  const run = { teamName, runId: 'run-1' };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await authority.start(teamName, () => undefined, async (report) => {
      report({ ...run, state: 'spawning', message: 'started', startedAt: '', updatedAt: '' });
      return { runId: run.runId, launchStatus: 'started' };
    });
    const write = authority.persistForRun(run, async () => {
      entered();
      await gate;
      await writeFile(join(teamPath, 'close.json'), 'settled');
    });
    await ready;
    authority.cleaned(run);
    let prepared = false;
    const deletion = owner.beginPermanentDeletion(teamName).then((intent) => {
      prepared = true;
      return intent;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prepared).toBe(false);
    release();
    await write;
    const intent = await deletion;
    expect(intent.phase).toBe('prepared');
    expect(await readFile(join(teamPath, 'close.json'), 'utf8')).toBe('settled');
    await owner.abortPreparedPermanentDeletion(intent);
  } finally {
    release();
    authority.cleaned(run);
    owner.dispose();
  }
});

it('rejects a stale run before TeamMembersMetaStore can change a replacement roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-generation-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'reused-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation));
  const run = { teamName, runId: 'old-run' };
  const roster = new TeamMembersMetaStore();
  try {
    await authority.start(teamName, () => undefined, async (report) => {
      report({ ...run, state: 'spawning', message: 'started', startedAt: '', updatedAt: '' });
      return { runId: run.runId, launchStatus: 'started' };
    });
    await rename(teamPath, join(root, 'teams', 'renamed-original'));
    await mkdir(teamPath);
    await writeFile(join(teamPath, 'config.json'), JSON.stringify({
      name: teamName, _backupIdentityId: 'replacement-c',
    }));
    await roster.writeMembers(teamName, [{ name: 'replacement-lead' }]);
    await expect(authority.persistForRun(run, () =>
      roster.updateMembers(teamName, (members) => [...members, { name: 'stale-member' }])
    )).rejects.toThrow('operator_required: provisioning run writer authority expired');
    expect((await roster.getMembers(teamName)).map((member) => member.name))
      .toEqual(['replacement-lead']);
  } finally {
    authority.cleaned(run);
    owner.dispose();
  }
});

it('rechecks generation at roster publication after a retained continuation was admitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-commit-generation-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'commit-reuse-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation));
  const run = { teamName, runId: 'old-run' };
  const roster = new TeamMembersMetaStore();
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await authority.start(teamName, () => undefined, async (report) => {
      report({ ...run, state: 'spawning', message: 'started', startedAt: '', updatedAt: '' });
      return { runId: run.runId, launchStatus: 'started' };
    });
    await roster.writeMembers(teamName, [{ name: 'original-lead' }]);
    const staleWrite = authority.persistForRun(run, () =>
      roster.updateMembers(teamName, async (members) => {
        entered();
        await paused;
        return [...members, { name: 'stale-member' }];
      })
    );
    await ready;
    await rename(teamPath, join(root, 'teams', 'renamed-original'));
    await mkdir(teamPath);
    await writeFile(join(teamPath, 'config.json'), JSON.stringify({
      name: teamName, _backupIdentityId: 'replacement-c',
    }));
    await roster.writeMembers(teamName, [{ name: 'replacement-lead' }]);
    resume();
    await expect(staleWrite).rejects.toThrow(
      'operator_required: provisioning run writer authority expired'
    );
    expect((await roster.getMembers(teamName)).map((member) => member.name))
      .toEqual(['replacement-lead']);
  } finally {
    resume();
    authority.cleaned(run);
    owner.dispose();
  }
});

it('retains failed-start authority until its reported run is cleaned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provisioning-failed-run-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'failed-run-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const authority = new TeamProvisioningRunWriterAuthority();
  authority.configure((name, operation, continuation) =>
    owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation));
  const run = { teamName, runId: 'run-1' };
  try {
    await expect(authority.start(teamName, () => undefined, async (report) => {
      report({ ...run, state: 'failed', message: 'spawn failed', startedAt: '', updatedAt: '' });
      throw new Error('spawn failed');
    })).rejects.toThrow('spawn failed');
    const deletion = owner.beginPermanentDeletion(teamName);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(owner.workSyncIdentity.readCurrent(teamName))
      .resolves.toEqual({ status: 'deleting' });
    authority.cleaned(run);
    const intent = await deletion;
    expect(intent.phase).toBe('prepared');
    await owner.abortPreparedPermanentDeletion(intent);
  } finally {
    authority.cleaned(run);
    owner.dispose();
  }
});
