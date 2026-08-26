import type { RosterAuthorizationTransactionRecord } from './TeamRosterAuthorizationLedger';

const TERMINAL = new Set(['committed', 'rolled-back', 'conflict']);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class RosterAuthorizationRecoveryScheduler {
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly recoverTeam: (teamName: string) => Promise<void>,
    private readonly nowMs: () => number,
    private readonly unknownReconcileIntervalMs: number
  ) {}

  scheduleRecord(record: Readonly<RosterAuthorizationTransactionRecord>): void {
    if (TERMINAL.has(record.status)) return;
    const key = this.recordKey(record.teamName, record.transactionId);
    const deadline = Date.parse(record.deadlineAt);
    const delay =
      record.status === 'launch-unknown'
        ? Math.max(1, this.unknownReconcileIntervalMs)
        : Number.isFinite(deadline)
          ? Math.max(0, Math.min(deadline - this.nowMs() + 1, MAX_TIMER_DELAY_MS))
          : 0;
    this.replaceTimer(key, delay, () => this.run(key, () => this.recoverTeam(record.teamName)));
  }

  scheduleTeam(teamName: string): void {
    const key = `${teamName}\u0000startup-scan`;
    if (this.timers.has(key)) return;
    this.scheduleRetry(key, () => this.recoverTeam(teamName));
  }

  scheduleStartupScan(recoverAllTeams: () => Promise<void>): void {
    const key = '\u0000all-teams-startup-scan';
    if (this.timers.has(key)) return;
    this.scheduleRetry(key, recoverAllTeams);
  }

  cancel(record: Readonly<RosterAuthorizationTransactionRecord>): void {
    const key = this.recordKey(record.teamName, record.transactionId);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.attempts.delete(key);
  }

  private run(key: string, operation: () => Promise<void>): void {
    this.timers.delete(key);
    void operation().then(
      () => this.attempts.delete(key),
      () => this.scheduleRetry(key, operation)
    );
  }

  private scheduleRetry(key: string, operation: () => Promise<void>): void {
    if (this.timers.has(key)) return;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const delay = Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
    this.replaceTimer(key, delay, () => this.run(key, operation));
  }

  private replaceTimer(key: string, delay: number, callback: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private recordKey(teamName: string, transactionId: string): string {
    return `${teamName}\u0000${transactionId}`;
  }
}
