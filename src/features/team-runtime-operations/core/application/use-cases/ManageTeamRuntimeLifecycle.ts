import type { RetryFailedRuntimeLanesResult } from '../../../contracts';
import type {
  TeamRuntimeEffectsPort,
  TeamRuntimeFeedPort,
  TeamRuntimeLifecycleCommandPort,
  TeamRuntimeStopPort,
} from '../ports/TeamRuntimeOperationPorts';

export class ManageTeamRuntimeLifecycle {
  constructor(
    private readonly lifecycle: TeamRuntimeLifecycleCommandPort,
    private readonly runtime: TeamRuntimeStopPort,
    private readonly feed: TeamRuntimeFeedPort,
    private readonly effects: TeamRuntimeEffectsPort
  ) {}

  async restartMember(teamName: string, memberName: string): Promise<void> {
    try {
      await this.lifecycle.restartMember(teamName, memberName);
    } finally {
      this.feed.invalidateMessageFeed(teamName);
    }
  }

  retryFailedRuntimeLanes(teamName: string): Promise<RetryFailedRuntimeLanesResult> {
    return this.lifecycle.retryFailedRuntimeLanes(teamName);
  }

  skipMemberForLaunch(teamName: string, memberName: string): Promise<void> {
    return this.lifecycle.skipMemberForLaunch(teamName, memberName);
  }

  async stopTeam(teamName: string): Promise<void> {
    this.effects.addStopBreadcrumb(teamName);
    await this.runtime.stopTeam(teamName);
  }
}
