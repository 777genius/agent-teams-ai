import {
  captureHostScheduleTarget,
  HostSmartScheduleRuntimeAdapter,
  restoreHostScheduleTarget,
} from '@features/agent-backend/main';

import type { DesktopBackendFeature } from '@features/agent-backend/main';
import type { HostScheduleRuntimeFactory } from '@main/services/schedule/SelectedScheduleDispatcher';
import type { IpcMainInvokeEvent } from 'electron';

interface DesktopScheduleScope {
  feature: DesktopBackendFeature;
  selected: boolean;
  captureSelection(): { contextId: string; isCurrent(): boolean };
  captureSender(event: IpcMainInvokeEvent): string | null;
}

/** Uses the existing Desktop shell and binding store; no scheduler-specific owner registry. */
export function createDesktopHostSchedules(current: () => DesktopScheduleScope | undefined) {
  return {
    /** Only the authenticated foreground may create/rebind a background schedule target. */
    async capture(event: IpcMainInvokeEvent, teamName: string) {
      const original = current(), selection = original?.captureSelection(),
        contextId = original?.captureSender(event);
      if (!original?.selected || !contextId || contextId !== selection?.contextId)
        throw new Error('Captured Host schedule context unavailable');
      const isCurrent = () => current() === original && selection.isCurrent() &&
        original.captureSender(event) === contextId;
      const target = await captureHostScheduleTarget(original.feature, contextId, teamName, { isCurrent });
      return { target, isCurrent };
    },
    /** Cron restores its original owner independently of the currently visible tab. */
    create: (async options => {
      const original = current();
      if (!original?.selected) throw new Error('Captured Host scheduler is unavailable');
      const target = await restoreHostScheduleTarget(original.feature, options.schedule.teamName,
        options.schedule.hostTarget, () => current() === original && original.selected && options.isCancelled?.() !== true);
      return new HostSmartScheduleRuntimeAdapter({ target, selection: options.schedule.teamName,
        runId: options.runId, taskFirst: options.schedule.taskFirst, getPreviousRuns: options.getPreviousRuns });
    }) satisfies HostScheduleRuntimeFactory['create'],
  };
}
