import type { TeamDirectoryRefreshCoordinatorPort } from '../ports/TeamDirectoryRendererPorts';

export class TeamDirectoryRefreshCoordinator<
  RequestScope,
> implements TeamDirectoryRefreshCoordinatorPort<RequestScope> {
  private latestTeamsFetchRequestId = 0;
  private globalTasksRefresh: Promise<void> | null = null;
  private globalTasksRefreshScope: RequestScope | null = null;
  private pendingFreshGlobalTasksRefresh = false;

  beginTeamsFetch(): number {
    this.latestTeamsFetchRequestId += 1;
    return this.latestTeamsFetchRequestId;
  }

  isLatestTeamsFetch(requestId: number): boolean {
    return this.latestTeamsFetchRequestId === requestId;
  }

  getGlobalTasksRefresh(): {
    request: Promise<void>;
    scope: RequestScope | null;
  } | null {
    return this.globalTasksRefresh
      ? {
          request: this.globalTasksRefresh,
          scope: this.globalTasksRefreshScope,
        }
      : null;
  }

  beginGlobalTasksRefresh(request: Promise<void>): void {
    this.globalTasksRefresh = request;
  }

  setGlobalTasksRefreshScope(scope: RequestScope): void {
    this.globalTasksRefreshScope = scope;
  }

  clearGlobalTasksRefresh(request: Promise<void>): void {
    if (this.globalTasksRefresh !== request) {
      return;
    }
    this.globalTasksRefresh = null;
    this.globalTasksRefreshScope = null;
  }

  queueFreshGlobalTasksRefresh(): void {
    this.pendingFreshGlobalTasksRefresh = true;
  }

  consumeFreshGlobalTasksRefresh(): boolean {
    const wasPending = this.pendingFreshGlobalTasksRefresh;
    this.pendingFreshGlobalTasksRefresh = false;
    return wasPending;
  }

  hasPendingFreshGlobalTasksRefresh(): boolean {
    return this.pendingFreshGlobalTasksRefresh;
  }

  reset(): void {
    this.latestTeamsFetchRequestId = 0;
    this.globalTasksRefresh = null;
    this.globalTasksRefreshScope = null;
    this.pendingFreshGlobalTasksRefresh = false;
  }
}
