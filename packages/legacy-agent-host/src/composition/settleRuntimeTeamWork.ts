import { publishNativeCommandOutput } from './publishNativeCommandOutput.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamRuntimeDeliveryPort } from '../team/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
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
  memberPasses: Map<string, Promise<void>>;
  onProgress(): void;
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
    const binding = normalizeBinding(entry.binding), key = runtimeDigest(binding);
    if (options.memberPasses.has(key)) continue;
    // Retain the actual operation, not a timeout lease. Runtime still owns the only native claim.
    const settleWorkSync = entry.settleWorkSync;
    let progressed = false;
    const pending = Promise.resolve().then(async () => {
      if (options.isSealed()) return;
      let before: string | undefined;
      try {
        if (runtimeDigest(normalizeBinding(entry.binding)) !== key) return;
        publishNativeCommandOutput(entry, options.runtime);
        const current = options.runtime.readSession(binding);
        before = inputState(current.record);
        if (current.attached && current.record?.nativeReady && current.record.phase === 'allocated')
          await options.runtime.dispatchNext(binding);
        if (!options.isSealed()) await settleWorkSync?.();
      } catch { /* A busy/held/revoked member never falls back to another runtime. */ }
      try {
        progressed = before !== undefined && before !== inputState(options.runtime.readCapturedSession(binding).record);
      } catch { /* Original physical custody remains held when its read is unavailable. */ }
    }).finally(() => {
      if (options.memberPasses.get(key) === pending) options.memberPasses.delete(key);
      if (progressed && !options.isSealed()) options.onProgress();
    });
    options.memberPasses.set(key, pending);
  }
}

function inputState(record: RuntimeSessionRecord | undefined): string {
  return runtimeDigest(record?.inputs.map(input => [input.intent.inputId, input.phase, input.terminal]) ?? []);
}
