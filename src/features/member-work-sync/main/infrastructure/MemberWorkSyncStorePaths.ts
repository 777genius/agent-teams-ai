import { TeamMemberStoragePaths } from '@main/services/team/TeamMemberStoragePaths';
import { join } from 'path';

export class MemberWorkSyncStorePaths {
  private readonly memberStorage: TeamMemberStoragePaths;

  constructor(private readonly teamsBasePath: string) {
    this.memberStorage = new TeamMemberStoragePaths(teamsBasePath);
  }

  getTeamRootDir(teamName: string): string {
    return join(this.teamsBasePath, teamName);
  }

  getTeamDir(teamName: string): string {
    return join(this.teamsBasePath, teamName, '.member-work-sync');
  }

  getSqliteFallbackReplicaPath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'sqlite-fallback-replica.json');
  }

  getStatusPath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'status.json');
  }

  getPendingReportsPath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'pending-reports.json');
  }

  getOutboxPath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'outbox.json');
  }

  getReportTokenSecretPath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'report-token-secret.json');
  }

  getIndexesDir(teamName: string): string {
    return join(this.getTeamDir(teamName), 'indexes');
  }

  getMetricsIndexPath(teamName: string): string {
    return join(this.getIndexesDir(teamName), 'metrics.json');
  }

  getOutboxIndexPath(teamName: string): string {
    return join(this.getIndexesDir(teamName), 'outbox-index.json');
  }

  getPendingReportsIndexPath(teamName: string): string {
    return join(this.getIndexesDir(teamName), 'pending-reports-index.json');
  }

  getLegacyStatusPath(teamName: string): string {
    return this.getStatusPath(teamName);
  }

  getLegacyPendingReportsPath(teamName: string): string {
    return this.getPendingReportsPath(teamName);
  }

  getLegacyOutboxPath(teamName: string): string {
    return this.getOutboxPath(teamName);
  }

  getMemberKey(memberName: string): string {
    return this.memberStorage.getMemberKey(memberName);
  }

  getMemberDir(teamName: string, memberName: string): string {
    return this.memberStorage.getMemberDir(teamName, memberName);
  }

  getMemberWorkSyncDir(teamName: string, memberName: string): string {
    return this.memberStorage.getMemberFeatureDir(teamName, memberName, '.member-work-sync');
  }

  getMemberStatusPath(teamName: string, memberName: string): string {
    return join(this.getMemberWorkSyncDir(teamName, memberName), 'status.json');
  }

  getMemberReportsPath(teamName: string, memberName: string): string {
    return join(this.getMemberWorkSyncDir(teamName, memberName), 'reports.json');
  }

  getMemberOutboxPath(teamName: string, memberName: string): string {
    return join(this.getMemberWorkSyncDir(teamName, memberName), 'outbox.json');
  }

  getMemberJournalPath(teamName: string, memberName: string): string {
    return join(this.getMemberWorkSyncDir(teamName, memberName), 'journal.jsonl');
  }

  async ensureMemberWorkSyncDir(teamName: string, memberName: string): Promise<void> {
    await this.memberStorage.ensureMemberMeta(teamName, memberName);
  }
}
