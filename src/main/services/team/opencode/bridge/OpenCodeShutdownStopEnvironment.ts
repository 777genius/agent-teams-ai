import { prepareOpenCodeShutdownStopEnvironment } from './OpenCodeMcpBridgeEnv';

import type { OpenCodeBridgeCommandName } from './OpenCodeBridgeCommandContract';

/**
 * Quit closes external admission before it stops teams, and from then on the
 * desktop refuses a control context to every new bridge child. Stopping this
 * app's own lanes still needs one. So the current binding is captured while
 * admission is open and lent only to Stop children, and only while the
 * shutdown "stop all teams" step holds it open. Launch, send and every other
 * command keep the refusal.
 */
const SHUTDOWN_STOP_COMMANDS: ReadonlySet<string> = new Set<OpenCodeBridgeCommandName>([
  'opencode.stopTeam',
  'opencode.stopOutcome',
  'opencode.reconcileStop',
]);

/** A handshake qualifies only when it is the handshake of one of the Stop commands. */
export function isOpenCodeShutdownStopCommand(
  command: OpenCodeBridgeCommandName,
  body: unknown
): boolean {
  if (SHUTDOWN_STOP_COMMANDS.has(command)) return true;
  if (command !== 'opencode.handshake' || !body || typeof body !== 'object') return false;
  const requiredCommand = (body as { requiredCommand?: unknown }).requiredCommand;
  return typeof requiredCommand === 'string' && SHUTDOWN_STOP_COMMANDS.has(requiredCommand);
}

/** Lane stops seen while the window was open; `pending` ones had not settled at release. */
export interface OpenCodeShutdownStopSummary {
  /** False when no matching binding was captured, so Stop children were refused as before. */
  captured: boolean;
  confirmed: number;
  unconfirmed: number;
  pending: number;
}

/** Counts lane stops while the quit window is open, for the shutdown diagnostic. */
export class OpenCodeShutdownStopTally {
  private current: OpenCodeShutdownStopSummary | null = null;

  open(captured: boolean): void {
    this.current = { captured, confirmed: 0, unconfirmed: 0, pending: 0 };
  }

  /** The counts at release; stops that settle later no longer change them. */
  release(): OpenCodeShutdownStopSummary | null {
    const summary = this.current && { ...this.current };
    this.current = null;
    return summary;
  }

  async track<T>(stop: () => Promise<T>, isConfirmed: (result: T) => boolean): Promise<T> {
    const counts = this.current;
    if (!counts) return stop();
    counts.pending += 1;
    let confirmed = false;
    try {
      const result = await stop();
      confirmed = isConfirmed(result);
      return result;
    } finally {
      counts.pending -= 1;
      counts[confirmed ? 'confirmed' : 'unconfirmed'] += 1;
    }
  }
}

export class OpenCodeShutdownStopEnvironment {
  private captured: NodeJS.ProcessEnv | null = null;
  private lent = false;

  /** Keeps only a successful child environment whose authority matches the current binding. */
  capture(
    previous: Readonly<NodeJS.ProcessEnv> | null,
    currentBoundChildEnv: Readonly<Record<string, string>>
  ): void {
    this.lent = false;
    this.captured = null;
    this.captured = prepareOpenCodeShutdownStopEnvironment(previous, currentBoundChildEnv);
  }

  /** Starts lending the captured environment; false when there is nothing to lend. */
  open(): boolean {
    this.lent = this.captured !== null;
    return this.lent;
  }

  /** Final: nothing is lent afterwards, and a released capture cannot be opened again. */
  release(): void {
    this.lent = false;
    this.captured = null;
  }

  /** A fresh copy for one Stop child, or null so the caller uses its normal provider. */
  environmentFor(command: OpenCodeBridgeCommandName, body: unknown): NodeJS.ProcessEnv | null {
    if (!this.lent || !this.captured || !isOpenCodeShutdownStopCommand(command, body)) return null;
    return { ...this.captured };
  }
}
