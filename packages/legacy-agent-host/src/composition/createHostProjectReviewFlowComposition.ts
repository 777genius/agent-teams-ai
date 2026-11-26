import { HostProjectReviewFlow } from '../team-project-context/HostProjectReviewFlow.js';
import type { ProjectTeamRelationsOptions } from '../team-project-context/HostProjectTeamRelations.js';
import type { TeamStore } from '../team/ports.js';

export function createHostProjectReviewFlowComposition(options: ProjectTeamRelationsOptions & {
  stores: ReadonlyMap<string, TeamStore>;
}) {
  const flow = new HostProjectReviewFlow(options);
  return {
    read: flow.read.bind(flow),
    execute: flow.execute.bind(flow),
    lookup: flow.lookup.bind(flow),
    synchronizeHistory: flow.synchronizeHistory.bind(flow),
  };
}
