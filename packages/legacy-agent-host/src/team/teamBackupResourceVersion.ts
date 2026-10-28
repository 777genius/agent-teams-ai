import { listTeamCommandEntries } from './commandEntries.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import type { TeamBinding, CommandReceipt } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore } from './ports.js';

interface RetainedPlan { schemaVersion: 1; commandId: string; fingerprint: string; writes: { path: string; after: { hash: string } }[] }
/** Caller holds the original Team resource fence. A version describes completed owner decisions, never mtime. */
export function teamBackupResourceVersion(store: TeamStore, binding: TeamBinding, path: string): string | undefined {
  const state = store.read<OwnerState>('state.json');
  if (!state || state.ready !== true || digest(state.binding) !== digest(binding)) throw new TeamOwnerError('hold');
  const team = `teams/${binding.teamName}/`, tasks = `tasks/${binding.teamName}/`;
  const taskFile = path.startsWith(tasks) && /^[A-Za-z0-9_-]+\.json$/.test(path.slice(tasks.length));
  const teamFile = path.startsWith(team) ? path.slice(team.length) : '';
  if (!taskFile && !['config.json', 'members.meta.json', 'kanban-state.json', 'sentMessages.json'].includes(teamFile) &&
    !/^inboxes\/[A-Za-z0-9_-]+\.json$/.test(teamFile)) return undefined;
  const decisions: unknown[] = [];
  for (const entry of listTeamCommandEntries(store)) {
    if (digest(entry.binding) !== digest(binding)) throw new TeamOwnerError('hold');
    if ('family' in entry) {
      // Group sends persist their canonical row directly, outside agent-targeted message receipts.
      if (entry.family === 'group-chat' && entry.request.operation === 'send' && teamFile === 'inboxes/user.json') {
        if (entry.phase !== 'completed') throw new TeamOwnerError('hold');
        decisions.push({ commandId: entry.commandId, fingerprint: entry.fingerprint });
      }
      if (entry.family === 'queued-discard' && teamFile === `inboxes/${entry.member}.json`) {
        if (entry.phase !== 'completed') throw new TeamOwnerError('hold');
        decisions.push({ commandId: entry.commandId, fingerprint: entry.fingerprint, discardedMessageIds: entry.discardedMessageIds });
      }
      continue;
    }
    const receipt: CommandReceipt = entry;
    if (receipt.phase === 'rejected') continue;
    if (receipt.command.operation === 'message.send') {
      if (teamFile !== 'sentMessages.json' && teamFile !== `inboxes/${receipt.command.payload.to}.json`) continue;
      if (receipt.phase !== 'completed') throw new TeamOwnerError('hold');
      decisions.push({ commandId: receipt.commandId, fingerprint: receipt.fingerprint, effects: receipt.effects });
      continue;
    }
    const plan = store.read<RetainedPlan>(`task-plans/${digest(receipt.commandId)}.json`);
    if (!plan || plan.schemaVersion !== 1 || plan.commandId !== receipt.commandId || plan.fingerprint !== receipt.fingerprint || !Array.isArray(plan.writes))
      throw new TeamOwnerError('hold');
    const writes = plan.writes.filter(write => write.path === path);
    if (!writes.length) continue;
    if (receipt.phase !== 'completed' || writes.some(write => !/^[a-f0-9]{64}$/.test(write.after?.hash))) throw new TeamOwnerError('hold');
    decisions.push({ commandId: receipt.commandId, fingerprint: receipt.fingerprint, writes });
  }
  // Config/member publication comes from the same recoverable owner state, not only Task plans.
  const configuration = ['config.json', 'members.meta.json'].includes(teamFile)
    ? { members: state.members.map(({ delivery: _delivery, ...member }) => member), removedMembers: state.removedMembers ?? [],
      rosterVersion: state.rosterVersion ?? null, savedSettings: state.savedSettings ?? null, lifecycle: state.lifecycle ?? null } : null;
  if (state.rosterProjection && configuration) throw new TeamOwnerError('hold');
  return digest({ binding, path, configuration, decisions: decisions.sort((a, b) => digest(a).localeCompare(digest(b))) });
}
