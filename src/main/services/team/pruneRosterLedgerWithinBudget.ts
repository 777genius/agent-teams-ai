import type { TeamRosterAuthorizationLedger } from './TeamRosterAuthorizationLedger';

const MAX_RECORDS_PER_PASS = 16;
const MAX_PASS_MS = 25;

export function pruneRosterLedgerWithinBudget(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string,
  now: () => number
): Promise<boolean> {
  const startedAt = now();
  return ledger.prune(teamName, MAX_RECORDS_PER_PASS, () => now() - startedAt >= MAX_PASS_MS);
}
