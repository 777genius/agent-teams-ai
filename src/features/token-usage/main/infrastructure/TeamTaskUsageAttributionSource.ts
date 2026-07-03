import type { TokenUsageTaskAttributionDto } from '../../contracts';
import type { TokenUsageTaskAttributionSourcePort } from '../../core/application';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import type { TeamTask } from '@shared/types';

type TeamTaskWithTeamName = TeamTask & { teamName: string };

export class TeamTaskUsageAttributionSource implements TokenUsageTaskAttributionSourcePort {
  constructor(private readonly taskReader: Pick<TeamTaskReader, 'getAllTasks'>) {}

  async listTaskAttributions(): Promise<TokenUsageTaskAttributionDto[]> {
    const tasks = await this.taskReader.getAllTasks();
    return tasks
      .map(toTaskAttribution)
      .filter((task): task is TokenUsageTaskAttributionDto => task !== null);
  }
}

function toTaskAttribution(task: TeamTaskWithTeamName): TokenUsageTaskAttributionDto | null {
  const workIntervals = (task.workIntervals ?? [])
    .map((interval) => ({
      startedAt: interval.startedAt,
      completedAt: interval.completedAt,
    }))
    .filter((interval) => interval.startedAt);

  if (!task.id || !task.teamName || workIntervals.length === 0) {
    return null;
  }

  return {
    id: task.id,
    displayId: task.displayId,
    teamName: task.teamName,
    owner: task.owner,
    subject: task.subject,
    status: task.status,
    workIntervals,
  };
}
