import { hostTeamSelectionKey } from '../contracts/teamSelection';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { TeamSummary } from '@shared/types/team';

/** Only owner-issued relations fold physical histories into their logical navigation row. */
export function projectHostTeamSummaries(rows: TeamSummary[], bindings: BackendConnectionSnapshot['bindings']): TeamSummary[] {
  const byHandle = new Map(bindings.map(binding => [binding.handle.handleId, binding]));
  const summaries = new Map(rows.map(row => [row.teamName, row]));
  const hidden = new Set<string>();
  for (const child of bindings) {
    const relation = child.projectContext;
    if (!relation) continue;
    const logical = byHandle.get(relation.logicalHandleId), childName = hostTeamSelectionKey(child.handle.handleId);
    if (!logical || logical.projectContext || !logical.ownerResourceRef ||
        logical.ownerResourceRef !== child.ownerResourceRef || !relation.projectPath || !relation.workContextId) continue;
    const parent = summaries.get(hostTeamSelectionKey(logical.handle.handleId)), history = summaries.get(childName);
    if (!parent || !history) continue;
    parent.projectHistoryContexts = [...(parent.projectHistoryContexts ?? []), { executionTeamName: childName,
      projectPath: relation.projectPath, memberCount: history.memberCount,
      ...(history.leadSessionId ? { leadSessionId: history.leadSessionId } : {}),
      ...(history.sessionHistory ? { sessionHistory: history.sessionHistory } : {}) }];
    parent.projectPathHistory = [...new Set([...(parent.projectPathHistory ?? []), relation.projectPath])];
    parent.taskCount += history.taskCount;
    if (history.lastActivity && (!parent.lastActivity || history.lastActivity > parent.lastActivity)) parent.lastActivity = history.lastActivity;
    hidden.add(childName);
  }
  return rows.filter(row => !hidden.has(row.teamName));
}
