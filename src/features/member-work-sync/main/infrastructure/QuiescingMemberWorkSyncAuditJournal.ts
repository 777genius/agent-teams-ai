import type {
  MemberWorkSyncAuditEvent,
  MemberWorkSyncAuditJournalPort,
} from '../../core/application';

export class QuiescingMemberWorkSyncAuditJournal implements MemberWorkSyncAuditJournalPort {
  private readonly quiescingTeams = new Set<string>();
  private readonly admittedAppendsByTeam = new Map<string, Set<Promise<void>>>();

  constructor(private readonly delegate: MemberWorkSyncAuditJournalPort) {}

  append(event: MemberWorkSyncAuditEvent): Promise<void> {
    if (this.quiescingTeams.has(event.teamName)) {
      return Promise.resolve();
    }

    const append = this.invokeDelegate(event);
    const admittedAppends = this.admittedAppendsByTeam.get(event.teamName) ?? new Set();
    admittedAppends.add(append);
    this.admittedAppendsByTeam.set(event.teamName, admittedAppends);

    void append.then(
      () => this.releaseAppend(event.teamName, append),
      () => this.releaseAppend(event.teamName, append)
    );

    return append;
  }

  beginTeamQuiesce(teamName: string): void {
    this.quiescingTeams.add(teamName);
  }

  async awaitTeamIdle(teamName: string): Promise<void> {
    while (true) {
      const admittedAppends = this.admittedAppendsByTeam.get(teamName);
      if (!admittedAppends || admittedAppends.size === 0) {
        return;
      }

      await Promise.allSettled([...admittedAppends]);
    }
  }

  resumeTeam(teamName: string): void {
    this.quiescingTeams.delete(teamName);
  }

  private invokeDelegate(event: MemberWorkSyncAuditEvent): Promise<void> {
    try {
      return Promise.resolve(this.delegate.append(event));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private releaseAppend(teamName: string, append: Promise<void>): void {
    const admittedAppends = this.admittedAppendsByTeam.get(teamName);
    if (!admittedAppends) {
      return;
    }

    admittedAppends.delete(append);
    if (admittedAppends.size === 0) {
      this.admittedAppendsByTeam.delete(teamName);
    }
  }
}
