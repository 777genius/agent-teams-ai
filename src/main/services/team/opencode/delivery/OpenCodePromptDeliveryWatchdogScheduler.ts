import {
  OPENCODE_PROMPT_WATCHDOG_GLOBAL_CONCURRENCY,
  OPENCODE_PROMPT_WATCHDOG_PER_TEAM_CONCURRENCY,
} from './OpenCodePromptDeliveryWatchdog';
import { OpenCodeRelayDiagnosticsLogGate } from './OpenCodeRelayDiagnosticsLogGate';

/** What a wake's relay reports back; a port that reports nothing stays valid. */
export interface OpenCodePromptDeliveryWatchdogRelayOutcome {
  diagnostics?: readonly string[];
}

export interface OpenCodePromptDeliveryWatchdogSchedulerDependencies {
  canDeliverToTeamRuntime(teamName: string): boolean;
  recoverBeforeDelivery(input: { teamName: string; memberName: string }): Promise<boolean>;
  /**
   * The relay's own account of the wake travels back here. Discarding it is
   * what let a wake that was refused on every attempt write nothing at all:
   * the only reader of a relay result was the inbox file-change path, so a lane
   * that never received a new inbox row explained itself nowhere.
   */
  relay(input: {
    teamName: string;
    memberName: string;
    messageId: string;
  }): Promise<OpenCodePromptDeliveryWatchdogRelayOutcome | null | undefined | void>;
  getInboxMessages(input: {
    teamName: string;
    memberName: string;
  }): Promise<readonly { messageId?: string; read?: boolean }[]>;
  resolveIdentity(input: {
    teamName: string;
    memberName: string;
  }): Promise<{ ok: boolean; laneId?: string } | null>;
  isLaneActive(input: { teamName: string; laneId: string }): Promise<boolean>;
  isRecordNotFoundError(error: unknown): boolean;
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
  diagnostic(message: string): void;
  getErrorMessage(error: unknown): string;
}

export interface OpenCodePromptDeliveryWatchdogStaleErrorInput {
  teamName: string;
  memberName: string;
  messageId: string;
  error: unknown;
}

export class OpenCodePromptDeliveryWatchdogScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly deadlines = new Map<string, number>();
  private readonly queue: {
    teamName: string;
    memberName: string;
    run: () => Promise<void>;
  }[] = [];
  private inFlight = 0;
  private disabledLogged = false;
  private readonly inFlightByTeam = new Map<string, number>();
  private readonly inFlightByMember = new Set<string>();
  /**
   * A lane blocked on one condition reports the same diagnostics for every wake
   * queued behind it, and a terminal write re-relays the whole lane, so those
   * wakes arrive in bursts. The operator needs the condition once per lane per
   * window, not once per wake, and that decision already exists: the FileWatcher
   * inbox path writes through. Re-deriving it here would give the same
   * condition two windows that drift apart. The instance is per scheduler so a
   * wake's window is its own - the watched path reports a different key space
   * and must not be silenced by a retry that happened to speak first.
   */
  private readonly relayDiagnosticsLogGate = new OpenCodeRelayDiagnosticsLogGate();

  constructor(private readonly deps: OpenCodePromptDeliveryWatchdogSchedulerDependencies) {}

  isEnabled(): boolean {
    const enabled = process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG !== '0';
    if (!enabled && !this.disabledLogged) {
      this.disabledLogged = true;
      this.deps.info(
        'OpenCode prompt delivery watchdog is disabled by CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG=0; using legacy prompt acceptance semantics.'
      );
    }
    return enabled;
  }

  schedule(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    if (!this.isEnabled()) {
      return;
    }
    const messageId = input.messageId?.trim();
    if (!messageId) return;
    const key = this.getKey({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId,
    });
    const delayMs = Math.max(500, Math.min(input.delayMs, 60_000));
    const deadlineMs = Date.now() + delayMs;
    const existing = this.timers.get(key);
    if (existing) {
      const existingDeadlineMs = this.deadlines.get(key);
      if (typeof existingDeadlineMs === 'number' && existingDeadlineMs <= deadlineMs + 25) {
        return;
      }
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.deadlines.delete(key);
      this.enqueue({
        teamName: input.teamName,
        memberName: input.memberName,
        run: async () => {
          if (!this.deps.canDeliverToTeamRuntime(input.teamName)) {
            const recovered = await this.deps.recoverBeforeDelivery({
              teamName: input.teamName,
              memberName: input.memberName,
            });
            if (!recovered) {
              return;
            }
          }
          try {
            this.logRelayDiagnostics({
              teamName: input.teamName,
              memberName: input.memberName,
              messageId,
              outcome: await this.deps.relay({
                teamName: input.teamName,
                memberName: input.memberName,
                messageId,
              }),
            });
          } catch (error) {
            if (
              await this.isStaleError({
                teamName: input.teamName,
                memberName: input.memberName,
                messageId,
                error,
              })
            ) {
              this.deps.debug(
                `[${input.teamName}] Ignoring stale OpenCode prompt delivery watchdog job for ${input.memberName}/${messageId}: ${this.deps.getErrorMessage(error)}`
              );
              return;
            }
            throw error;
          }
        },
      });
    }, delayMs);
    this.timers.set(key, timer);
    this.deadlines.set(key, deadlineMs);
  }

  /**
   * Severity follows the diagnostics themselves, and the gate decides it:
   * anything off the informational allowlist makes the whole line a warning,
   * so a lane that is genuinely stuck reaches the durable log. The dedup key is
   * the member lane and the signature is the diagnostics alone - the message id
   * that happened to hit the condition is presentation only, so a queue of rows
   * cannot walk past the window one message id at a time.
   */
  private logRelayDiagnostics(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    outcome: OpenCodePromptDeliveryWatchdogRelayOutcome | null | undefined | void;
  }): void {
    this.relayDiagnosticsLogGate.log(
      {
        warn: (message) => this.deps.warn(message),
        // The gate calls its non-warning channel `debug`; this path routes that
        // line to `diagnostic`. Both stay off the console, but a wake that keeps
        // being refused is expected control flow that still has to leave a
        // durable trace of why it keeps deferring - and `diagnostic` is the
        // durable channel that is not an error. The watched inbox path,
        // which only ever reports a row that just arrived, has nothing to
        // record between arrivals and keeps `debug`.
        debug: (message) => this.deps.diagnostic(message),
      },
      {
        dedupKey: this.getMemberKey(input.teamName, input.memberName),
        prefix: `[${input.teamName}] delivery watchdog relay diagnostics for ${input.memberName}/${input.messageId}`,
        diagnostics: input.outcome?.diagnostics,
        nowMs: Date.now(),
      }
    );
  }

  async isStaleError(input: OpenCodePromptDeliveryWatchdogStaleErrorInput): Promise<boolean> {
    if (!this.deps.isRecordNotFoundError(input.error)) {
      return false;
    }
    if (!this.deps.canDeliverToTeamRuntime(input.teamName)) {
      return true;
    }

    const inboxMessages = await this.deps
      .getInboxMessages({ teamName: input.teamName, memberName: input.memberName })
      .catch(() => []);
    const targetMessage = inboxMessages.find((message) => message.messageId === input.messageId);
    if (!targetMessage || targetMessage.read) {
      return true;
    }

    const identity = await this.deps
      .resolveIdentity({ teamName: input.teamName, memberName: input.memberName })
      .catch(() => null);
    if (!identity?.ok || !identity.laneId) {
      return true;
    }

    const laneActive = await this.deps
      .isLaneActive({ teamName: input.teamName, laneId: identity.laneId })
      .catch(() => false);
    return !laneActive;
  }

  cancelTeam(teamName: string): void {
    for (const key of Array.from(this.timers.keys())) {
      if (key.startsWith(`opencode-delivery:${teamName}:`)) {
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
        this.deadlines.delete(key);
      }
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.teamName === teamName) {
        this.queue.splice(index, 1);
      }
    }
  }

  private getKey(input: { teamName: string; memberName: string; messageId: string }): string {
    return `opencode-delivery:${input.teamName}:${input.memberName.toLowerCase()}:${input.messageId}`;
  }

  private enqueue(input: { teamName: string; memberName: string; run: () => Promise<void> }): void {
    this.queue.push(input);
    this.drain();
  }

  private drain(): void {
    while (this.inFlight < OPENCODE_PROMPT_WATCHDOG_GLOBAL_CONCURRENCY && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((queued) => {
        const memberKey = this.getMemberKey(queued.teamName, queued.memberName);
        return (
          (this.inFlightByTeam.get(queued.teamName) ?? 0) <
            OPENCODE_PROMPT_WATCHDOG_PER_TEAM_CONCURRENCY && !this.inFlightByMember.has(memberKey)
        );
      });
      if (nextIndex < 0) {
        return;
      }
      const [job] = this.queue.splice(nextIndex, 1);
      if (!job) {
        return;
      }
      this.inFlight += 1;
      this.inFlightByTeam.set(job.teamName, (this.inFlightByTeam.get(job.teamName) ?? 0) + 1);
      const memberKey = this.getMemberKey(job.teamName, job.memberName);
      this.inFlightByMember.add(memberKey);
      void job
        .run()
        .catch((error: unknown) => {
          this.deps.warn(
            `OpenCode prompt delivery watchdog job failed: ${this.deps.getErrorMessage(error)}`
          );
        })
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          const teamInFlight = (this.inFlightByTeam.get(job.teamName) ?? 1) - 1;
          if (teamInFlight > 0) {
            this.inFlightByTeam.set(job.teamName, teamInFlight);
          } else {
            this.inFlightByTeam.delete(job.teamName);
          }
          this.inFlightByMember.delete(memberKey);
          this.drain();
        });
    }
  }

  private getMemberKey(teamName: string, memberName: string): string {
    return `${teamName}::${memberName.trim().toLowerCase()}`;
  }
}
