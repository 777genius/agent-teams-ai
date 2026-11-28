import type {
  KanbanState,
  TeamConfig,
  TeamMemberSnapshot,
  TeamProcess,
  TeamTaskWithKanban,
} from './team';
import type { AutonomousGoalStatus } from '@features/agent-backend/contracts';

export interface TeamViewSnapshot {
  autonomousGoal?: AutonomousGoalStatus;
  autonomousGoalAvailable?: boolean;
  teamName: string;
  config: TeamConfig;
  tasks: TeamTaskWithKanban[];
  members: TeamMemberSnapshot[];
  kanbanState: KanbanState;
  processes: TeamProcess[];
  warnings?: string[];
  isAlive?: boolean;
}
