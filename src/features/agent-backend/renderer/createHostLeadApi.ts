import { hostTeamRunId } from '../contracts/teamRunSelection';

import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { LeadActivitySnapshot, LeadContextUsageSnapshot } from '@shared/types/team';

/** Existing Lead views stay bound to their original captured Host owner and read fence. */
export function createHostLeadApi(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  resolve(
    key: string,
    current: () => boolean
  ): Promise<{ handle: BackendHandle; assertCurrent(): void }>;
}) {
  function read(key: string, kind: 'activity'): Promise<LeadActivitySnapshot>;
  function read(key: string, kind: 'context'): Promise<LeadContextUsageSnapshot>;
  async function read(
    key: string,
    kind: 'activity' | 'context'
  ): Promise<LeadActivitySnapshot | LeadContextUsageSnapshot> {
    const current = options.captureScope(),
      selected = await options.resolve(key, current);
    selected.assertCurrent();
    const result = await options.backend.invoke({
      handle: selected.handle,
      commandId: crypto.randomUUID(),
      operation: kind === 'activity' ? 'team.lead.activity.read' : 'team.lead.context.read',
      payload: {},
    });
    selected.assertCurrent();
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    if (!result.value || !('kind' in result.value))
      throw new HostTeamOperationError('invalid-result', 'unknown');
    const view = result.value;
    if (view.kind !== 'team-lead-activity' && view.kind !== 'team-lead-context')
      throw new HostTeamOperationError('invalid-result', 'unknown');
    const runId = view.launch
      ? hostTeamRunId(selected.handle.handleId, view.launch.launchId, view.launch.rosterRevision)
      : null;
    if (kind === 'activity' && view.kind === 'team-lead-activity')
      return { state: view.state, runId };
    if (kind === 'context' && view.kind === 'team-lead-context')
      return { usage: view.usage, runId };
    throw new HostTeamOperationError('invalid-result', 'unknown');
  }
  return {
    getLeadActivity: (key: string) => read(key, 'activity'),
    getLeadContext: (key: string) => read(key, 'context'),
  };
}
