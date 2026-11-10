import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HostWorktreeGit } from '../adapters/worktrees/HostWorktreeGit.js';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { materializeWorktree } from '../team-launch/materializeWorktree.js';
import { launchWorktreeReceiptSchema } from '../team-launch/worktreeSchema.js';
import type { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';
import type { OwnedWorktreeBinding } from '../team-launch/worktreeContracts.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import { runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import type { RuntimeCaptureSource } from './runtimeCaptureSource.js';

export function hasRuntimeWorktrees(source: RuntimeCaptureSource): boolean {
  return (
    !!source.savedSettings.worktree ||
    source.members.some((member) => member.settings.isolation === 'worktree')
  );
}

export function runtimeWorktreeGit(profile: TeamHostProfile): HostWorktreeGit {
  let path = profile.owner.storageRoot;
  for (const segment of [
    '.host-worktrees',
    runtimeDigest({ ownerId: profile.owner.ownerId, profileId: profile.owner.profileId }),
  ]) {
    path = join(path, segment);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new TeamLaunchError('hold', 'worktree-root');
  }
  return new HostWorktreeGit(path);
}

export async function planRuntimeWorktrees(options: {
  team: HostedTeam;
  source: RuntimeCaptureSource;
  git: HostWorktreeGit;
  previous: { source: RuntimeCaptureSource; record: TeamLaunchRecord }[];
  assertCurrent(): void;
}): Promise<NonNullable<RuntimeCaptureSource['worktrees']>> {
  const { source, git, team } = options;
  const plans: NonNullable<RuntimeCaptureSource['worktrees']> = [];
  const previous = (memberId: string, name?: string): OwnedWorktreeBinding | undefined => {
    for (const candidate of options.previous) {
      if (!candidate.record.worktreePreparation?.completedSourceDigest) continue;
      if (name !== undefined && candidate.source.savedSettings.worktree?.trim() !== name) continue;
      const row = candidate.source.worktrees?.find((item) => item.memberIds.includes(memberId));
      if (!row) continue;
      const raw = candidate.record.worktrees?.find(
        (item) => item.planDigest === git.digest(row.plan)
      );
      if (!raw) throw new TeamLaunchError('hold', 'worktree-owned-receipt-missing');
      const receipt = launchWorktreeReceiptSchema.parse(raw);
      if (receipt.state !== 'completed' || !receipt.binding)
        throw new TeamLaunchError('hold', 'worktree-owned-receipt-incomplete');
      return receipt.binding;
    }
    return undefined;
  };
  const lead = source.members.find((member) => member.role === 'lead');
  if (!lead) throw new TeamLaunchError('invalid', 'capture-lead');
  if (source.savedSettings.worktree) {
    const name = source.savedSettings.worktree.trim();
    const prior = previous(lead.memberId, name);
    const plan = await git.plan({
      baseCwd: source.savedSettings.cwd,
      teamId: team.definition.binding.teamId,
      slot: { kind: 'named', name },
      ...(prior ? { previous: prior } : {}),
    });
    options.assertCurrent();
    plans.push({
      memberIds: source.members
        .filter(
          (member) =>
            member.role === 'lead' ||
            (member.settings.cwd === undefined && member.settings.isolation !== 'worktree')
        )
        .map((member) => member.memberId),
      plan,
    });
  }
  for (const member of source.members.filter(
    (member) => member.role === 'member' && member.settings.isolation === 'worktree'
  )) {
    const prior = previous(member.memberId);
    const plan = await git.plan({
      baseCwd: member.settings.cwd ?? source.savedSettings.cwd,
      teamId: team.definition.binding.teamId,
      slot: { kind: 'member', name: member.memberId },
      ...(prior ? { previous: prior } : {}),
    });
    options.assertCurrent();
    plans.push({ memberIds: [member.memberId], plan });
  }
  return plans;
}

export async function materializeRuntimeWorktrees(options: {
  profile: TeamHostProfile;
  team: HostedTeam;
  source: RuntimeCaptureSource;
  store: TeamOwnerStore;
  launchId: string;
  git: HostWorktreeGit;
  assertCurrent(): void;
}): Promise<void> {
  const path = `launches/${runtimeDigest(options.launchId)}.json`;
  const fenced = <T>(action: () => T): T =>
    options.team.owner.withLaunchAuthority(options.profile.principalId, 'control', () => {
      options.assertCurrent();
      return action();
    });
  const record = () => {
    const value = options.store.read<TeamLaunchRecord>(path);
    if (
      !value?.worktreePreparation ||
      value.fingerprint !== runtimeDigest(value.definition) ||
      runtimeDigest(value.worktreePreparation.intent) !== runtimeDigest(options.source)
    )
      throw new TeamLaunchError('hold', 'worktree-preparation-changed');
    return value;
  };
  for (const row of options.source.worktrees ?? []) {
    await materializeWorktree(row.plan, options.git, {
      assertCurrent: options.assertCurrent,
      read: () =>
        fenced(() => {
          const prior = record().worktrees?.find(
            (item) => item.planDigest === options.git.digest(row.plan)
          );
          return {
            plan: row.plan,
            ...(prior ? { receipt: launchWorktreeReceiptSchema.parse(prior) } : {}),
          };
        }),
      write: (next, expected) =>
        fenced(() => {
          const saved = record(),
            index = saved.worktrees?.findIndex((item) => item.planDigest === next.planDigest) ?? -1;
          const current = index === -1 ? undefined : saved.worktrees![index];
          if (runtimeDigest(current ?? null) !== runtimeDigest(expected ?? null))
            throw new TeamLaunchError('hold', 'worktree-receipt-changed');
          const rows = [...(saved.worktrees ?? [])];
          if (index === -1) rows.push(next);
          else rows[index] = next;
          const nextRecord = { ...saved, worktrees: rows };
          if (Buffer.byteLength(JSON.stringify(nextRecord)) > 1024 * 1024)
            throw new TeamLaunchError('hold', 'worktree-receipt-budget');
          options.store.write(path, nextRecord);
        }),
    });
    options.assertCurrent();
  }
}

/** Every native factory rechecks the exact owned target, including restored/cold captured entries. */
export async function assertRuntimeWorktree(entry: MemberEntry): Promise<void> {
  if (entry.team.capture === undefined) return;
  const source = runtimeCaptureSourceSchema.parse(entry.team.capture);
  const row = source.worktrees?.find((value) => value.memberIds.includes(entry.profile.memberId));
  if (!row) return;
  const binding = source.worktreeBindings?.find((value) => value.slotId === row.plan.slotId);
  if (!binding || entry.profile.cwd !== row.plan.targetPath)
    throw new TeamLaunchError('hold', 'worktree-runtime-binding');
  await new HostWorktreeGit(dirname(row.plan.targetPath)).inspect(row.plan, binding);
}
