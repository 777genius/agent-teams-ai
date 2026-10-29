import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';

/** Observes exact original durable commands, including selections published before Runtime open. */
export function readLaunchRestorations(
  launch: Pick<TeamLaunchOwner, 'readRestorations'>,
  runtime: Pick<RuntimeOwner, 'readSession'>
) {
  const selected = launch.readRestorations();
  return {
    launchId: selected.launchId,
    rosterRevision: selected.rosterRevision,
    preparations: selected.preparations.map((group) => ({
      ...group,
      members: group.members.map((member) => ({ ...member })),
    })),
    restorations: selected.restorations.map(({ commandId, member, current }) => {
      const binding = member.binding!,
        restore = member.restore!;
      let phase: RuntimeSessionRecord['phase'] | 'unavailable' = 'unopened';
      let custody: RuntimeSessionRecord['custody'] = 'released',
        attached = false;
      try {
        const observed = runtime.readSession(binding);
        phase = observed.record?.phase ?? 'unopened';
        custody = observed.record?.custody ?? 'released';
        attached = observed.attached;
      } catch {
        // Read failure cannot erase the original intent or prove cleanup/success.
        phase = 'unavailable';
        custody = 'unknown';
      }
      return {
        commandId,
        memberId: member.memberId,
        reference: restore.reference,
        sourceGeneration: restore.sourceBinding.generation,
        selectedGeneration: binding.generation,
        current,
        phase,
        custody,
        attached,
      };
    }),
  };
}
