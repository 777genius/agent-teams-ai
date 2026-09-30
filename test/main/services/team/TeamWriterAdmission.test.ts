import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendWithTeamWriterPreflight, withCapturedTeamWriterIdentity, withTeamWriterAdmission } from '@main/services/team/permanent-deletion/TeamWriterAdmission';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('expires a delayed local write even while the same team identity remains present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-deadline-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'deadline-team';
  const publicPath = join(root, 'teams', teamName);
  await mkdir(publicPath, { recursive: true });
  await writeFile(join(publicPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await withCapturedTeamWriterIdentity(owner, teamName, async () => {
      clock.mockReturnValue(now + 30_001);
      await expect(withTeamWriterAdmission(owner, teamName, async () => {
        await writeFile(join(publicPath, 'late.json'), 'late write');
      })).rejects.toThrow('operator_required: team writer workflow expired');
    });
    await expect(readFile(join(publicPath, 'late.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    clock.mockRestore();
    owner.dispose();
  }
});

it('does not let a queued A writer adopt and mutate same-name C', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-generation-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'generation-team';
  const publicPath = join(root, 'teams', teamName);
  const heldA = join(root, 'teams', 'held-a');
  await mkdir(publicPath, { recursive: true });
  await writeFile(join(publicPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  let release!: () => void;
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => { captured = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = withCapturedTeamWriterIdentity(owner, teamName, async () => {
    captured();
    await gate;
    return withTeamWriterAdmission(owner, teamName, async () => {
      await writeFile(join(publicPath, 'stale.json'), 'A stale write');
    });
  });
  try {
    await ready;
    const prepared = await owner.beginPermanentDeletion(teamName);
    await owner.commitPermanentDeletionBoundary(prepared);
    await rename(publicPath, heldA);
    await mkdir(publicPath);
    await writeFile(join(publicPath, 'config.json'), JSON.stringify({
      name: teamName, _backupIdentityId: 'replacement-c-identity',
    }));
    release();
    await expect(pending).rejects.toThrow('operator_required: team writer admission changed');
    expect(await readFile(join(heldA, 'config.json'), 'utf8')).toContain(teamName);
    expect(await readFile(join(publicPath, 'config.json'), 'utf8')).toContain('replacement-c-identity');
    await expect(readFile(join(publicPath, 'stale.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release();
    owner.dispose();
    await pending.catch(() => undefined);
  }
});

it('keeps a blocked provider send outside the lock and drains it before deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-send-drain-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'send-drain-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const owner = new TeamBackupService();
  await owner.initialize();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const send = sendWithTeamWriterPreflight(owner, teamName, async () => {
    entered();
    await gate;
    return withTeamWriterAdmission(owner, teamName, async () => {
      await writeFile(join(teamPath, 'sent.json'), 'sent');
    });
  });
  try {
    await ready;
    await expect(Promise.race([
      owner.withTeamIdentityFence(teamName, () => Promise.resolve('available')),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('provider held identity lock')), 1_000)),
    ])).resolves.toBe('available');
    let prepared = false;
    const deletion = owner.beginPermanentDeletion(teamName).then((intent) => {
      prepared = true;
      return intent;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prepared).toBe(false);
    release();
    await expect(send).rejects.toThrow('operator_required: team writer admission changed');
    const intent = await deletion;
    expect(intent.phase).toBe('prepared');
    await expect(readFile(join(teamPath, 'sent.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await owner.abortPreparedPermanentDeletion(intent);
  } finally {
    release();
    await send.catch(() => undefined);
    owner.dispose();
  }
});
