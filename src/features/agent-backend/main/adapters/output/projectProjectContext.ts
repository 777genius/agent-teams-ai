import { hostProjectContextSnapshotSchema } from '@agent-teams/legacy-agent-host/team-project-context/contracts';

import { hostTeamSelectionKey } from '../../../contracts/teamSelection';
import { parseRosterReplacement, rosterRevision, rosterRow, rosterText } from '../rosterValues';

import type { BackendProjectContextSnapshot, BackendProjectLaunchSource } from '../../../contracts/projectContext';

export function projectProjectContext(value: unknown): BackendProjectContextSnapshot {
  const source = hostProjectContextSnapshotSchema.parse(value), raw = source.view;
  let view: BackendProjectContextSnapshot['view'];
  if (raw.state === 'ready') {
    const { executionHandleId, ...rest } = raw;
    view = { ...rest, executionTeamName: hostTeamSelectionKey(executionHandleId) };
  } else if (raw.state === 'redirect') {
    const { logicalHandleId, ...rest } = raw;
    view = { ...rest, logicalTeamName: hostTeamSelectionKey(logicalHandleId) };
  } else view = raw;
  return { kind: 'team-project-context', view,
    histories: source.histories.map(row => ({ executionTeamName: hostTeamSelectionKey(row.executionHandleId),
      projectPath: row.projectPath, workContextId: row.workContextId })),
    ...(source.prepared ? { prepared: { executionHandle: { handleId: source.prepared.executionHandleId },
      rosterCommandId: source.prepared.rosterCommandId, sourceRevision: source.prepared.sourceRevision } } : {}) };
}
export function projectProjectLaunchSource(value: unknown): BackendProjectLaunchSource {
  const source = rosterRow(value, ['kind', 'logicalHandleId', 'sourceRevision', 'probeRevision', 'roster']);
  if (source.kind !== 'team-project-launch-source') throw new Error('Invalid project launch source');
  const roster = rosterRow(source.roster, ['commandId', 'expected']);
  return { kind: 'team-project-launch-source', logicalHandleId: rosterText(source.logicalHandleId),
    sourceRevision: rosterRevision(source.sourceRevision), probeRevision: rosterRevision(source.probeRevision),
    roster: { commandId: rosterText(roster.commandId), expected: parseRosterReplacement(roster.expected) } };
}
