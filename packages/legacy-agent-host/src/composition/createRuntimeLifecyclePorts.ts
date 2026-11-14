import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { TeamRuntimeDeliveryPort, TeamBinding } from '../team/contracts.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { ModelProbeOwner } from '../management/ModelProbeOwner.js';

/** Original captured cleanup only; no selection, generation allocation, input admission or native retry. */
export function createRuntimeLifecyclePorts(options: {
  runtime: RuntimeOwner; entries: ReadonlyMap<string, MemberEntry>; delivery: TeamRuntimeDeliveryPort;
  assertWriter(): void; closeEndpoint(entry: MemberEntry): Promise<void>;
  assertAvailable?(binding: Parameters<RuntimeOwner['stopCapturedSession']>[0]): void;
  readiness?: {
    retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner }>;
    probes: Pick<ModelProbeOwner, 'cancelTeamPreparations'>;
  };
}) {
  return {
    delivery: options.delivery,
    runtime: {
      readCapturedSession: options.runtime.readCapturedSession.bind(options.runtime),
      ...(options.readiness ? { async cancelPreparations(binding: TeamBinding) {
        options.assertWriter();
        for (const retained of options.readiness!.retainedLaunches.values())
          if (runtimeDigest(retained.team.definition.binding) === runtimeDigest(binding))
            retained.launch.retireModelReadiness();
        await options.readiness!.probes.cancelTeamPreparations(runtimeDigest(binding));
        options.assertWriter();
      } } : {}),
      async stopCapturedSession(binding: Parameters<RuntimeOwner['stopCapturedSession']>[0]) {
        options.assertWriter();
        options.assertAvailable?.(binding);
        options.readiness?.retainedLaunches.get(runtimeDigest({ teamId: binding.teamId, launchId: binding.runId }))
          ?.launch.retireModelReadiness(binding.memberId);
        const entry = options.entries.get(runtimeDigest(binding));
        const result = await options.runtime.stopCapturedSession(binding);
        options.assertWriter();
        if (entry) {
          if (entry.provider && !(await entry.provider.cleanup())) throw new RuntimeOwnerError('hold');
          await options.closeEndpoint(entry);
        }
        options.assertWriter();
        return result;
      },
    },
  };
}

/** Existing owned cleanup continues for every installed entry before retained unavailable debt is checked. */
export async function closeRuntimeEntries(options: {
  runtime: RuntimeOwner; entries: ReadonlyMap<string, MemberEntry>;
  opening: ReadonlySet<Promise<unknown>>; pumping?: Promise<void>;
  disposeWake(): Promise<unknown>; closeEndpoint(entry: MemberEntry): Promise<void>;
  assertUnavailableReleased(): void;
}): Promise<void> {
  const openingEntries = [...options.entries.values()].filter(entry => {
    try { return !!entry.provider && !options.runtime.readCapturedSession(entry.binding).attached; }
    catch { return false; } // A corrupt record must not skip original owned cleanup.
  });
  const stop = (entry: MemberEntry) => options.runtime.stopCapturedSession(entry.binding);
  const stopping = [...options.entries.values()].map(stop);
  const cleanup = async (entry: MemberEntry) => entry.provider ? entry.provider.cleanup() : true;
  const openingCleanup = new Map(openingEntries.map(entry => [entry, cleanup(entry)]));
  await Promise.allSettled([
    options.disposeWake(), ...stopping, ...openingCleanup.values(), ...options.opening,
    ...(options.pumping ? [options.pumping] : []),
  ]);
  let complete = true;
  for (const entry of options.entries.values()) {
    try {
      const state = await stop(entry);
      if (state && (state.phase !== 'closed' || state.custody !== 'released')) complete = false;
    } catch { complete = false; }
    try {
      if (!(await (openingCleanup.get(entry) ?? cleanup(entry)))) complete = false;
    } catch { complete = false; }
    try { await options.closeEndpoint(entry); } catch { complete = false; }
  }
  try { options.assertUnavailableReleased(); } catch { complete = false; }
  if (!complete) throw new RuntimeOwnerError('hold');
}
