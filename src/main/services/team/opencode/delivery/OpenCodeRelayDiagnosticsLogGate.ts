import { isInformationalOpenCodeRuntimeDeliveryDiagnostic } from './OpenCodeRuntimeDeliveryDiagnostics';

/**
 * The one place that decides whether a relay's diagnostics reach the log.
 *
 * A relay result is the only account the app gives of why a message did or did
 * not reach a runtime, and exactly one caller turns it into a log line: the
 * FileWatcher inbox-change path in `src/main/index.ts`. Every other path that
 * relays discards the result, the retry/wake sweep included, so a lane that
 * keeps deferring is invisible: a retry wake that keeps deferring writes
 * nothing at all, and a ten-minute stall can produce no log line describing
 * itself. The two lines such a stretch does produce exist only because a new
 * inbox row happened to arrive and take the watched path.
 *
 * Concentrating the decision in a module is what lets the other paths adopt it
 * without each re-deriving the dedup and severity rules. The FileWatcher path
 * uses it today; the delivery retry path adopts it next.
 *
 * Being visible must not mean flooding. A busy inbox re-reports the same
 * diagnostics on every pass, so an unchanged condition writes at most once per
 * window while a CHANGED condition writes immediately: a transition is always
 * news, a repeat almost never is.
 */

export const OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS = 60_000;
/** Bounds the window map for a long-lived process with many inboxes. */
export const OPENCODE_RELAY_DIAGNOSTICS_LOG_MAX_TRACKED_KEYS = 512;

/**
 * `warn` is the durable channel; `debug` and `info` are explicitly not.
 *
 * `Logger.warn` is what feeds `emitToLogSinks` and so the persisted diagnostics
 * file. Informational relay diagnostics - `opencode session status busy`,
 * `opencode_delivery_response_pending`, a scheduled session refresh - are
 * expected control flow and stay off that channel on purpose: a lane that
 * legitimately defers a wake every few seconds must not manufacture warnings.
 *
 * They are emitted at `debug` rather than `info`. Neither is durable and
 * neither prints at the default console level (WARN in development, ERROR in
 * production), but `debug` is the level an operator actually raises when
 * chasing a lane, while `info` is the level whose name suggests the line was
 * recorded somewhere. It was not. What an operator needs durably out of a
 * stalled lane is the warning allowlist, and that is unchanged.
 */
export interface OpenCodeRelayDiagnosticsLogLine {
  level: 'warn' | 'debug';
  message: string;
}

/** The subset of the app logger this gate writes through. */
export interface OpenCodeRelayDiagnosticsLogWriter {
  warn(message: string): void;
  debug(message: string): void;
}

export interface OpenCodeRelayDiagnosticsLogInput {
  dedupKey: string;
  prefix: string;
  diagnostics: readonly string[] | undefined;
  nowMs: number;
}

export function hasWarningOpenCodeRelayDiagnostics(diagnostics: readonly string[]): boolean {
  return diagnostics.some(
    (diagnostic) => !isInformationalOpenCodeRuntimeDeliveryDiagnostic(diagnostic)
  );
}

export class OpenCodeRelayDiagnosticsLogGate {
  private readonly lastLogged = new Map<string, { signature: string; loggedAtMs: number }>();

  constructor(
    private readonly dedupMs: number = OPENCODE_RELAY_DIAGNOSTICS_LOG_DEDUP_MS,
    private readonly maxTrackedKeys: number = OPENCODE_RELAY_DIAGNOSTICS_LOG_MAX_TRACKED_KEYS
  ) {}

  /**
   * The line to write for `diagnostics`, or null when nothing is worth writing:
   * no diagnostics at all, or the same condition already written this window.
   *
   * The dedup signature is the diagnostics ALONE; `prefix` names the message
   * that happened to hit the condition and is presentation only. A lane blocked
   * on one condition reports it identically for every message queued behind it,
   * so a caller whose prefix carries a message id would otherwise let a queue of
   * rows walk straight past the window one id at a time.
   */
  note(input: OpenCodeRelayDiagnosticsLogInput): OpenCodeRelayDiagnosticsLogLine | null {
    if (!input.diagnostics?.length) {
      return null;
    }
    const signature = input.diagnostics.join('; ');
    const previous = this.lastLogged.get(input.dedupKey);
    if (previous?.signature === signature && input.nowMs - previous.loggedAtMs < this.dedupMs) {
      return null;
    }
    if (!previous && this.lastLogged.size >= this.maxTrackedKeys) {
      const oldestKey = this.lastLogged.keys().next();
      if (!oldestKey.done) {
        this.lastLogged.delete(oldestKey.value);
      }
    }
    this.lastLogged.set(input.dedupKey, { signature, loggedAtMs: input.nowMs });
    return {
      level: hasWarningOpenCodeRelayDiagnostics(input.diagnostics) ? 'warn' : 'debug',
      message: `${input.prefix}: ${signature}`,
    };
  }

  /**
   * Writes what `note` allows, and nothing when it allows nothing. Callers use
   * this rather than branching on the line themselves so the "does this reach
   * the log" decision stays in one tested place.
   */
  log(writer: OpenCodeRelayDiagnosticsLogWriter, input: OpenCodeRelayDiagnosticsLogInput): void {
    const line = this.note(input);
    if (line) {
      writer[line.level](line.message);
    }
  }

  clear(): void {
    this.lastLogged.clear();
  }
}

/**
 * The dedup window has to outlive a single relay result, so the process shares
 * one gate. Used by the FileWatcher inbox path today.
 */
export const openCodeRelayDiagnosticsLogGate = new OpenCodeRelayDiagnosticsLogGate();
