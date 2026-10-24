import { MemberWorkSyncNudgeDispatchScheduler } from '../work-sync/scheduling/MemberWorkSyncNudgeDispatchScheduler.js';
import type { MemberEntry } from './MemberEntry.js';
/** Same bounded scheduler as Main; only exact current native connection callbacks may drain their canonical outbox. */
export function createRuntimeWorkSyncWake(options: {
  entries: ReadonlyMap<string, MemberEntry>;
  isCurrent(entry: MemberEntry): boolean;
  isSealed(): boolean;
}) {
  const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
    listLifecycleActiveTeamNames: async () =>
      options.isSealed()
        ? []
        : [
            ...new Set(
              [...options.entries.values()]
                .filter((entry) => entry.settleWorkSync && options.isCurrent(entry))
                .map((entry) => entry.delivery.teamName)
            ),
          ],
    dispatchDue: async (teams, signal) => {
      for (const entry of options.entries.values()) {
        if (options.isSealed() || signal?.aborted) break;
        if (teams.includes(entry.delivery.teamName) && options.isCurrent(entry)) {
          try {
            await entry.settleWorkSync?.();
          } catch {
            /* Original receipt remains held by its own owner. */
          }
        }
      }
      return { claimed: 0, delivered: 0, retryable: 0, superseded: 0, terminal: 0 };
    },
  });
  scheduler.start();
  return scheduler;
}
