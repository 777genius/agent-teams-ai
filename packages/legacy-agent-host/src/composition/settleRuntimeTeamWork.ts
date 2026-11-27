import { publishNativeCommandOutput } from './publishNativeCommandOutput.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamRuntimeDeliveryPort } from '../team/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { HostInteractionControls } from './HostInteractionControls.js';

/** One existing coordinator pump pass. Every physical effect remains with its original owner. */
export async function settleRuntimeTeamWork(options: {
  launches: Iterable<TeamLaunchOwner>;
  teams: Iterable<HostedTeam>;
  entries: Iterable<MemberEntry>;
  runtime: RuntimeOwner;
  delivery: TeamRuntimeDeliveryPort;
  interactions: HostInteractionControls;
  isSealed(): boolean;
  available(teamId: string): boolean;
  settleGoal(team: HostedTeam): Promise<void>;
}): Promise<void> {
  const entries = [...options.entries];
  for (const launch of options.launches) {
    try { launch.refresh(); } catch { /* Original roster/custody debt remains held. */ }
  }
  for (const team of options.teams) {
    if (options.isSealed()) break;
    if (!options.available(team.definition.binding.teamId)) continue;
    try {
      await team.owner.resumeTaskCommands(options.delivery);
      if (options.isSealed()) break;
      await team.owner.resumeDeliveries(options.delivery);
      await options.settleGoal(team);
    } catch { /* Durable pending/held obligations remain with their original owner. */ }
  }
  await options.interactions.pump(entries);
  for (const entry of entries) {
    if (options.isSealed()) break;
    try {
      publishNativeCommandOutput(entry, options.runtime);
      const current = options.runtime.readSession(entry.binding);
      if (current.attached && current.record?.nativeReady && current.record.phase === 'allocated')
        await options.runtime.dispatchNext(entry.binding);
      await entry.settleWorkSync?.();
    } catch { /* A busy/held/revoked member never falls back to another runtime. */ }
  }
}
