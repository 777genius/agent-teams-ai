/** Structural path capability from the original feature owner; no ambient root lookup. */
export interface MemberWorkSyncReportJournalPaths {
  getTeamRootDir(teamName: string): string;
  getPendingReportsIndexPath(teamName: string): string;
  getMemberReportsPath(teamName: string, memberName: string): string;
  ensureMemberWorkSyncDir(teamName: string, memberName: string): Promise<void>;
}
