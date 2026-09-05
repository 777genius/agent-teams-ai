/**
 * Delivery-time self-heal for a primary lane that holds no committed session.
 *
 * When the primary lane's runtime never committed its session record, every
 * send is answered with a "no stored session" refusal and the ordinary retry
 * ladder cannot win: nothing a retry does can cause the missing commit to
 * happen, so the row spends its whole attempt budget in under a minute and then
 * stays terminal for the life of the team. The one signal that IS locally
 * decidable is the lane's own storage, so this module turns "the lane directory
 * holds no runtime evidence" into a bounded, exactly-once re-bootstrap of the
 * lead.
 *
 * Every constant here is a margin against healing a lane that is merely slow. A
 * healthy lane can commit its session before its first refusal is even
 * observed, which is why the evidence check outranks the timer: a lane whose
 * evidence is already on disk is a race with the commit, never a heal.
 */
export const PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN = 2;
export const PRIMARY_LANE_REBOOTSTRAP_MIN_INTERVAL_MS = 60_000;
export const PRIMARY_LANE_REBOOTSTRAP_FIRST_FAILURE_GRACE_MS = 20_000;
export const PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS = 15_000;

/**
 * The ladder ships enabled.
 *
 * Relaunching the lead without a user asking for it is a product decision, not
 * a bug fix, so it is switchable from exactly one place: flip this default, or
 * inject `isOpenCodePrimaryLaneSelfHealEnabled`. With it off the lane still
 * refuses the unwinnable send and the delivery row still settles - it just
 * settles terminal immediately instead of after a bounded ladder, and no
 * relaunch is ever started.
 */
export const OPENCODE_PRIMARY_LANE_SELF_HEAL_DEFAULT_ENABLED = true;

export const OPENCODE_PRIMARY_LANE_BOOTSTRAP_MISSING_REASON =
  'opencode_primary_lane_bootstrap_missing';
export const OPENCODE_PRIMARY_LANE_BOOTSTRAP_UNRECOVERABLE_REASON =
  'opencode_primary_lane_bootstrap_unrecoverable';

export const PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC =
  'the lead re-bootstrap budget is exhausted for this run.';
export const PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC =
  'lead re-bootstrap is disabled for this app.';
export const PRIMARY_LANE_REBOOTSTRAP_GRACE_WINDOW_DIAGNOSTIC =
  'OpenCode primary lane bootstrap commit is still within its grace window.';
export const PRIMARY_LANE_REBOOTSTRAP_RATE_LIMITED_DIAGNOSTIC =
  'OpenCode primary lane re-bootstrap is rate limited.';

export type PrimaryLaneBootstrapSelfHealDecision =
  /**
   * The lane holds runtime evidence, so the missing session record is a read
   * that raced the commit (or a recovered lane whose active run id moved), not
   * this incident's shape. The caller must fall through and deliver as before.
   */
  | { action: 'not_applicable'; diagnostic: string }
  | { action: 'wait'; retryAfterMs: number; diagnostic: string }
  | { action: 'rebootstrap'; attempt: number; retryAfterMs: number }
  /**
   * The ladder is over. `diagnostic` is a clause, not a sentence:
   * `describePrimaryLaneBootstrapSelfHeal` appends it after "... for <member>".
   */
  | { action: 'give_up'; diagnostic: string };

/**
 * The discriminator, exactly: the lane directory EXISTS, it holds state (the
 * delivery ledger the failing sends wrote), and it holds no runtime evidence. A
 * lane with evidence raced its commit; a lane with no directory at all was
 * never bootstrapped by this run and belongs to the recovery/reattach paths,
 * not here.
 */
export function isUnbootstrappedOpenCodePrimaryLaneStorage(
  storage:
    | {
        laneDirectoryExists?: boolean;
        hasStateOnDisk?: boolean;
        hasRuntimeEvidenceOnDisk?: boolean;
      }
    | undefined
): boolean {
  return (
    storage?.laneDirectoryExists === true &&
    storage.hasStateOnDisk === true &&
    storage.hasRuntimeEvidenceOnDisk === false
  );
}

export function decidePrimaryLaneBootstrapSelfHeal(input: {
  firstMissingObservedAtMs: number | null;
  nowMs: number;
  attemptsForRun: number;
  lastAttemptAtMs: number | null;
  /** `false` (or absent) means the lane is not provably unbootstrapped. */
  laneIsUnbootstrapped?: boolean;
  /** `false` opts the whole ladder out; absent means enabled. */
  selfHealEnabled?: boolean;
}): PrimaryLaneBootstrapSelfHealDecision {
  const retryAfterMs = PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS;
  // Evidence outranks the opt-out as well: a lane that is merely racing its own
  // commit must fall through to the unchanged delivery path either way, and
  // must never be terminalized just because the ladder is switched off.
  if (input.laneIsUnbootstrapped === false) {
    return {
      action: 'not_applicable',
      diagnostic:
        'OpenCode primary lane is not provably unbootstrapped; the probe raced the commit.',
    };
  }
  if (input.selfHealEnabled === false) {
    return { action: 'give_up', diagnostic: PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC };
  }
  const observedForMs =
    input.firstMissingObservedAtMs == null
      ? 0
      : Math.max(0, input.nowMs - input.firstMissingObservedAtMs);
  if (observedForMs < PRIMARY_LANE_REBOOTSTRAP_FIRST_FAILURE_GRACE_MS) {
    return {
      action: 'wait',
      retryAfterMs,
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_GRACE_WINDOW_DIAGNOSTIC,
    };
  }
  if (input.attemptsForRun >= PRIMARY_LANE_REBOOTSTRAP_MAX_ATTEMPTS_PER_RUN) {
    return { action: 'give_up', diagnostic: PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC };
  }
  if (
    input.lastAttemptAtMs != null &&
    input.nowMs - input.lastAttemptAtMs < PRIMARY_LANE_REBOOTSTRAP_MIN_INTERVAL_MS
  ) {
    return {
      action: 'wait',
      retryAfterMs,
      diagnostic: PRIMARY_LANE_REBOOTSTRAP_RATE_LIMITED_DIAGNOSTIC,
    };
  }
  return { action: 'rebootstrap', attempt: input.attemptsForRun + 1, retryAfterMs };
}

export function describePrimaryLaneBootstrapSelfHeal(input: {
  memberName: string;
  decision?: PrimaryLaneBootstrapSelfHealDecision | null;
}): string {
  const suffix =
    input.decision?.action === 'rebootstrap'
      ? `; re-bootstrapping the lead (attempt ${input.decision.attempt}).`
      : input.decision?.action === 'give_up'
        ? `; ${input.decision.diagnostic}`
        : '; waiting for the bootstrap commit.';
  return `OpenCode primary lane has no committed session record for ${input.memberName}${suffix}`;
}

export interface OpenCodePrimaryLaneBootstrapSelfHealRequest {
  teamName: string;
  laneId: string;
  memberName: string;
  runId: string | null;
  reason: string;
}

/**
 * `nowMs`, `inspectLaneStorage` and `isOpenCodePrimaryLaneSelfHealEnabled` are
 * function-valued properties rather than method signatures: the tracker reads
 * each of them off this object before deciding whether to call it - a default
 * for the clock, a presence check for the probe - and a method signature would
 * make every one of those reads an unbound method reference. The ports that are
 * only ever called in place stay methods.
 */
export interface OpenCodePrimaryLaneBootstrapSelfHealPorts {
  nowMs?: () => number;
  /** Lane storage probe. Only a provably unbootstrapped lane may escalate. */
  inspectLaneStorage?: (input: { teamName: string; laneId: string }) => Promise<{
    laneDirectoryExists?: boolean;
    hasStateOnDisk?: boolean;
    hasRuntimeEvidenceOnDisk?: boolean;
  }>;
  /**
   * The opt-out. Absent means
   * `OPENCODE_PRIMARY_LANE_SELF_HEAL_DEFAULT_ENABLED`; returning `false` keeps
   * every refusal path intact but never starts a relaunch.
   */
  isOpenCodePrimaryLaneSelfHealEnabled?: () => boolean;
  rebootstrapPrimaryLane(input: {
    teamName: string;
    reason: string;
    attempt: number;
  }): Promise<boolean>;
  logWarning?(message: string): void;
}

interface SelfHealEntry {
  firstMissingObservedAtMs: number;
  attempts: number;
  lastAttemptAtMs: number | null;
  inFlight: Promise<boolean> | null;
  /** Claimed synchronously, so the storage probe cannot be raced into two heals. */
  deciding: boolean;
}

/**
 * In-memory only, keyed by team and run: an app restart or a fresh launch
 * resets the budget, so a re-bootstrap loop can never survive a crash, and a
 * stale run's attempts can never be spent by its successor.
 */
export class OpenCodePrimaryLaneBootstrapSelfHealTracker {
  private readonly entries = new Map<string, SelfHealEntry>();
  private readonly nowMs: () => number;
  private readonly isEnabled: () => boolean;

  constructor(private readonly ports: OpenCodePrimaryLaneBootstrapSelfHealPorts) {
    this.nowMs = ports.nowMs ?? (() => Date.now());
    this.isEnabled =
      ports.isOpenCodePrimaryLaneSelfHealEnabled ??
      ((): boolean => OPENCODE_PRIMARY_LANE_SELF_HEAL_DEFAULT_ENABLED);
  }

  private keyOf(teamName: string, runId: string | null): string {
    // U+0000 as an escape, never as a byte: a raw control character in a source
    // file makes git treat the whole module as binary and review sees nothing.
    return `${teamName.trim().toLowerCase()}\u0000${runId ?? ''}`;
  }

  reset(teamName: string, runId: string | null): void {
    this.entries.delete(this.keyOf(teamName, runId));
  }

  async request(
    request: OpenCodePrimaryLaneBootstrapSelfHealRequest
  ): Promise<PrimaryLaneBootstrapSelfHealDecision> {
    const key = this.keyOf(request.teamName, request.runId);
    const nowMs = this.nowMs();
    const entry = this.entries.get(key) ?? {
      firstMissingObservedAtMs: nowMs,
      attempts: 0,
      lastAttemptAtMs: null,
      inFlight: null,
      deciding: false,
    };
    this.entries.set(key, entry);
    if (entry.inFlight || entry.deciding) {
      // Several delivery sources can hit the same lane inside one grace window;
      // only one of them may start a relaunch.
      return {
        action: 'wait',
        retryAfterMs: PRIMARY_LANE_REBOOTSTRAP_RETRY_DELAY_MS,
        diagnostic: 'OpenCode primary lane re-bootstrap is already in flight.',
      };
    }
    entry.deciding = true;
    let decision: PrimaryLaneBootstrapSelfHealDecision;
    try {
      const probe = this.ports.inspectLaneStorage;
      // An unreadable lane is NOT proof of an unbootstrapped one, so a failing
      // probe resolves to "not applicable" and the caller's old path stands.
      const laneIsUnbootstrapped = probe
        ? await probe({ teamName: request.teamName, laneId: request.laneId })
            .then(isUnbootstrappedOpenCodePrimaryLaneStorage)
            .catch(() => false)
        : undefined;
      decision = decidePrimaryLaneBootstrapSelfHeal({
        firstMissingObservedAtMs: entry.firstMissingObservedAtMs,
        nowMs,
        attemptsForRun: entry.attempts,
        lastAttemptAtMs: entry.lastAttemptAtMs,
        laneIsUnbootstrapped,
        selfHealEnabled: this.isEnabled(),
      });
    } finally {
      entry.deciding = false;
    }
    if (decision.action !== 'rebootstrap') {
      return decision;
    }
    entry.attempts = decision.attempt;
    entry.lastAttemptAtMs = nowMs;
    this.ports.logWarning?.(
      `[${request.teamName}] opencode_primary_lane_rebootstrap_requested ` +
        `member=${request.memberName} run=${request.runId ?? 'none'} attempt=${decision.attempt} ` +
        `reason=${request.reason}`
    );
    // Fire and forget: a relaunch takes tens of seconds and the caller must not
    // hold the delivery open for it. The ledger's deferral owns the next wake.
    entry.inFlight = this.ports
      .rebootstrapPrimaryLane({
        teamName: request.teamName,
        reason: request.reason,
        attempt: decision.attempt,
      })
      .catch((error: unknown) => {
        this.ports.logWarning?.(
          `[${request.teamName}] opencode_primary_lane_rebootstrap_failed ` +
            `member=${request.memberName} error=${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      })
      .finally(() => {
        if (this.entries.get(key) === entry) {
          entry.inFlight = null;
        }
      });
    return decision;
  }
}
