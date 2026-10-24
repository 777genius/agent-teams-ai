import { createHostTeamsApi } from './createHostTeamsApi';
import { TeamProductReadOrder } from './TeamProductReadOrder';

import type { AgentBackendApi, BackendOperation } from '../contracts/operations';
import type { TeamsAPI } from '@shared/types/api';

const reads = new Set<BackendOperation>([
  'group.list',
  'group.reaction.read',
  'group.lookup',
  'process.list',
  'process.lookup',
  'process.pending.read',
  'crossTeam.outbox.read',
  'crossTeam.lookup',
  'team.lead.activity.read',
  'team.lead.context.read',
  'team.activity.stats.read',
  'team.activity.logs.read',
  'task.attachment.read',
  'message.attachments.read',
  'message.attachment.read',
  'review.getTaskChanges',
  'review.getTaskSummaries',
  'review.getAgentChanges',
  'review.getChangeStats',
  'review.authorizeWatch',
  'review.getGitFileLog',
  'review.lookup',
  'review.recovery.read',
  'review.invalidateSummaries',
  'task.get',
  'tasks.list',
  'team.snapshot',
  'team.changes.read',
  'command.lookup',
  'team.lifecycle.read',
  'team.lifecycle.lookup',
  'team.lifecycle.purge.lookup',
  'team.queue.read',
  'team.queue.lookup',
  'team.roster.read',
  'team.roster.lookup',
  'team.member.actions.read',
  'team.member.action.lookup',
  'team.launch.read',
  'team.launch.configuration.read',
  'team.launch.model.configuration.read',
  'team.launch.probe.start',
  'team.launch.probe.read',
  'team.launch.probe.cancel',
  'runtime.approval.settings.read',
  'runtime.interaction.preview.read',
  'runtime.read',
  'runtime.activity.snapshot',
  'runtime.activity.feed',
]);

/** Direct Host controls and compatibility Team reads share only read-order metadata. */
export function createHostBackendRenderer(
  legacy: TeamsAPI,
  source: AgentBackendApi,
  captureScope: () => () => boolean
): { teams: TeamsAPI; backend: AgentBackendApi } {
  const readOrder = new TeamProductReadOrder();
  const backend: AgentBackendApi = {
    ...(source.stoppedImport
      ? {
          stoppedImport: async (request) => {
            const current = captureScope();
            if (!current())
              return {
                ok: false as const,
                reason: 'source-changed' as const,
                outcome: 'not-dispatched' as const,
              };
            const result = await source.stoppedImport!(request);
            return current()
              ? result
              : {
                  ok: false as const,
                  reason: 'source-changed' as const,
                  outcome: 'unknown' as const,
                };
          },
        }
      : {}),
    ...(source.watchReviewFiles ? { watchReviewFiles: source.watchReviewFiles.bind(source) } : {}),
    ...(source.unwatchReviewFiles
      ? { unwatchReviewFiles: source.unwatchReviewFiles.bind(source) }
      : {}),
    ...(source.onReviewFileChange
      ? { onReviewFileChange: source.onReviewFileChange.bind(source) }
      : {}),
    async getConnections() {
      const current = captureScope();
      if (!current()) throw new Error('Team context changed');
      const result = await source.getConnections();
      if (!current()) throw new Error('Team context changed');
      return result;
    },
    async invoke(request) {
      const current = captureScope();
      if (!current()) return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      // Preferences change only the private approval policy. Subsequent native
      // product effects arrive through their ordinary Team feed; this ACK does
      // not change a snapshot, roster or the alive/custody fields read by getData.
      const invalidatesTeamReads =
        !reads.has(request.operation) && request.operation !== 'runtime.approval.settings.update';
      const handleId = request.handle.handleId;
      const affected =
        request.operation === 'crossTeam.send'
          ? [handleId, request.payload.target.handleId]
          : [handleId];
      if (invalidatesTeamReads) {
        readOrder.capture(current);
        affected.forEach((id) => readOrder.invalidateReads(id));
      }
      try {
        const result = await source.invoke(request);
        return current() ? result : { ok: false, code: 'forbidden', outcome: 'unknown' };
      } finally {
        if (invalidatesTeamReads && current())
          affected.forEach((id) => readOrder.invalidateReads(id));
      }
    },
  };
  return { backend, teams: createHostTeamsApi(legacy, backend, captureScope, readOrder) };
}
