import { readAutonomousGoalControl, readAutonomousGoalStatus } from '../contracts/autonomousGoal';
import { HostTeamOperationError } from '../contracts/taskSubmission';
import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import type { AutonomousGoalControl, AutonomousGoalStatus } from '../contracts/autonomousGoal';
import type { AgentBackendApi } from '../contracts/operations';

/** One original explicit control. Unknown transport never creates a replacement command. */
export async function controlAutonomousGoal(options: {
  backend: AgentBackendApi;
  teamName: string;
  commandId: string;
  request: AutonomousGoalControl;
  isCurrent(): boolean;
}): Promise<AutonomousGoalStatus> {
  const request = readAutonomousGoalControl(options.request);
  const handle = { handleId: parseHostTeamSelectionKey(options.teamName) };
  if (!options.isCurrent()) throw new Error('Team context changed');
  const result = await options.backend.invoke({
    handle,
    commandId: options.commandId,
    operation: 'goal.control',
    payload: request,
  });
  if (!options.isCurrent()) throw new Error('Team context changed');
  if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome, options.commandId);
  const status = readAutonomousGoalStatus(result.value);
  if (status.goalId !== request.goalId) throw new Error('Goal identity changed');
  return status;
}
