import type { TeamTaskWithKanban } from '@shared/types';

export interface TeamTaskDetailRendererPorts {
  readTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null>;
  notifyTaskLead(teamName: string, message: string): Promise<void>;
}
