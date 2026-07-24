import type { RefreshTeamMessagesHeadResult } from '../ports/TeamMessageFeedRendererPorts';

export interface TeamMessageFeedCoordinatorSnapshot {
  hasPendingFreshHeadRefresh: boolean;
  hasPendingFreshMemberActivityRefresh: boolean;
  hasQueuedHeadRefreshAfterOlder: boolean;
}

export class TeamMessageFeedCoordinator {
  private readonly headRequests = new Map<string, Promise<RefreshTeamMessagesHeadResult>>();
  private readonly olderRequests = new Map<string, Promise<void>>();
  private readonly queuedHeadRequests = new Map<string, Promise<RefreshTeamMessagesHeadResult>>();
  private readonly pendingFreshHeadRefreshes = new Set<string>();
  private readonly memberActivityRequests = new Map<string, Promise<void>>();
  private readonly pendingFreshMemberActivityRefreshes = new Set<string>();
  private readonly pendingReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getHeadRequest(teamName: string): Promise<RefreshTeamMessagesHeadResult> | undefined {
    return this.headRequests.get(teamName);
  }

  setHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): void {
    this.headRequests.set(teamName, request);
  }

  deleteHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): boolean {
    if (this.headRequests.get(teamName) !== request) return false;
    this.headRequests.delete(teamName);
    return true;
  }

  markFreshHeadRefreshPending(teamName: string): void {
    this.pendingFreshHeadRefreshes.add(teamName);
  }

  consumeFreshHeadRefresh(teamName: string): boolean {
    return this.pendingFreshHeadRefreshes.delete(teamName);
  }

  getOlderRequest(teamName: string): Promise<void> | undefined {
    return this.olderRequests.get(teamName);
  }

  setOlderRequest(teamName: string, request: Promise<void>): void {
    this.olderRequests.set(teamName, request);
  }

  deleteOlderRequest(teamName: string, request: Promise<void>): boolean {
    if (this.olderRequests.get(teamName) !== request) return false;
    this.olderRequests.delete(teamName);
    return true;
  }

  getQueuedHeadRequest(teamName: string): Promise<RefreshTeamMessagesHeadResult> | undefined {
    return this.queuedHeadRequests.get(teamName);
  }

  setQueuedHeadRequest(teamName: string, request: Promise<RefreshTeamMessagesHeadResult>): void {
    this.queuedHeadRequests.set(teamName, request);
  }

  deleteQueuedHeadRequest(
    teamName: string,
    request: Promise<RefreshTeamMessagesHeadResult>
  ): boolean {
    if (this.queuedHeadRequests.get(teamName) !== request) return false;
    this.queuedHeadRequests.delete(teamName);
    return true;
  }

  getMemberActivityRequest(teamName: string): Promise<void> | undefined {
    return this.memberActivityRequests.get(teamName);
  }

  setMemberActivityRequest(teamName: string, request: Promise<void>): void {
    this.memberActivityRequests.set(teamName, request);
  }

  deleteMemberActivityRequest(teamName: string, request: Promise<void>): boolean {
    if (this.memberActivityRequests.get(teamName) !== request) return false;
    this.memberActivityRequests.delete(teamName);
    return true;
  }

  markFreshMemberActivityRefreshPending(teamName: string): void {
    this.pendingFreshMemberActivityRefreshes.add(teamName);
  }

  consumeFreshMemberActivityRefresh(teamName: string): boolean {
    return this.pendingFreshMemberActivityRefreshes.delete(teamName);
  }

  setPendingReplyTimer(teamName: string, timer: ReturnType<typeof setTimeout>): void {
    this.clearPendingReplyTimer(teamName);
    this.pendingReplyTimers.set(teamName, timer);
  }

  deletePendingReplyTimer(teamName: string, timer: ReturnType<typeof setTimeout>): boolean {
    if (this.pendingReplyTimers.get(teamName) !== timer) return false;
    this.pendingReplyTimers.delete(teamName);
    return true;
  }

  clearPendingReplyTimer(teamName: string): void {
    const timer = this.pendingReplyTimers.get(teamName);
    if (timer == null) return;
    clearTimeout(timer);
    this.pendingReplyTimers.delete(teamName);
  }

  clearTeam(teamName: string): void {
    this.headRequests.delete(teamName);
    this.olderRequests.delete(teamName);
    this.queuedHeadRequests.delete(teamName);
    this.pendingFreshHeadRefreshes.delete(teamName);
    this.memberActivityRequests.delete(teamName);
    this.pendingFreshMemberActivityRefreshes.delete(teamName);
    this.clearPendingReplyTimer(teamName);
  }

  reset(): void {
    for (const teamName of this.pendingReplyTimers.keys()) {
      this.clearPendingReplyTimer(teamName);
    }
    this.headRequests.clear();
    this.olderRequests.clear();
    this.queuedHeadRequests.clear();
    this.pendingFreshHeadRefreshes.clear();
    this.memberActivityRequests.clear();
    this.pendingFreshMemberActivityRefreshes.clear();
  }

  snapshot(teamName: string): TeamMessageFeedCoordinatorSnapshot {
    return {
      hasPendingFreshHeadRefresh: this.pendingFreshHeadRefreshes.has(teamName),
      hasPendingFreshMemberActivityRefresh: this.pendingFreshMemberActivityRefreshes.has(teamName),
      hasQueuedHeadRefreshAfterOlder: this.queuedHeadRequests.has(teamName),
    };
  }
}

export const defaultTeamMessageFeedCoordinator = new TeamMessageFeedCoordinator();
