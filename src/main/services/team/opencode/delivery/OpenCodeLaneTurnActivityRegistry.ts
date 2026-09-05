/**
 * In-memory record of the last prompt-delivery turn state per OpenCode lane.
 *
 * The delivery service knows exactly when a lane's turn starts ('active', a
 * prompt was accepted) and when it settles ('idle'); nothing else in the app
 * sees a secondary lane's turn end (the orchestrator transcript projection
 * carries no turn-end row, so log-based stall detection could only classify a
 * silent member as "mid turn" and wait for the 10-minute mid-turn threshold).
 * The stall monitor reads the settle time from here instead.
 */

export type OpenCodeLaneTurnState = 'active' | 'idle';

export interface OpenCodeLaneTurnActivitySample {
  laneId: string;
  state: OpenCodeLaneTurnState;
  /** ISO timestamp of the observation. */
  observedAt: string;
}

/**
 * Team and member are folded into one map key. The separator is written as the
 * `\u0000` escape on purpose: a literal NUL byte in a source file has been
 * committed twice in this repository already, and `test/main/sourceControlCharacters.test.ts`
 * fails the build if one comes back.
 */
function memberKey(teamName: string, memberName: string): string {
  return `${teamName.trim().toLowerCase()}\u0000${memberName.trim().toLowerCase()}`;
}

export class OpenCodeLaneTurnActivityRegistry {
  private readonly samples = new Map<string, OpenCodeLaneTurnActivitySample>();

  note(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    state: OpenCodeLaneTurnState;
    observedAt?: string;
  }): void {
    this.samples.set(memberKey(input.teamName, input.memberName), {
      laneId: input.laneId,
      state: input.state,
      observedAt: input.observedAt ?? new Date().toISOString(),
    });
  }

  get(teamName: string, memberName: string): OpenCodeLaneTurnActivitySample | null {
    return this.samples.get(memberKey(teamName, memberName)) ?? null;
  }

  /** ISO time since which the member's lane has been idle, or null while active/unknown. */
  getIdleSince(teamName: string, memberName: string): string | null {
    const sample = this.get(teamName, memberName);
    return sample?.state === 'idle' ? sample.observedAt : null;
  }

  /** Snapshot of every member of a team: member name (lower-case) -> sample. */
  listTeam(teamName: string): Map<string, OpenCodeLaneTurnActivitySample> {
    const prefix = `${teamName.trim().toLowerCase()}\u0000`;
    const result = new Map<string, OpenCodeLaneTurnActivitySample>();
    for (const [key, sample] of this.samples) {
      if (key.startsWith(prefix)) {
        result.set(key.slice(prefix.length), sample);
      }
    }
    return result;
  }

  clear(): void {
    this.samples.clear();
  }
}

export const openCodeLaneTurnActivityRegistry = new OpenCodeLaneTurnActivityRegistry();

/**
 * Record a lane's turn state, and mirror it to the lead-activity notifier when
 * the caller identified the recipient as the team lead - the OpenCode lead has
 * no stdin stream, so this is the only signal that turns its card from
 * "processing" back to idle.
 *
 * Lead identity is the caller's decision (`isOpenCodeLeadRecipient`), not this
 * module's: the primary lane is shared by same-model teammates, so being on it
 * is not proof of being the lead.
 *
 * The registry write happens first and unconditionally: a secondary lane has no
 * lead card to update but its turn state is exactly what the stall monitor needs,
 * and a notifier that throws must not cost the caller the sample it just observed.
 */
export function noteOpenCodeLaneTurnActivity(
  input: {
    teamName: string;
    memberName: string;
    laneId: string;
    /** Resolved by the caller with `isOpenCodeLeadRecipient`. */
    isLeadRecipient: boolean;
    state: OpenCodeLaneTurnState;
    observedAt: string;
  },
  ports: {
    notifyLeadTurnActivity?(notification: {
      teamName: string;
      memberName: string;
      laneId: string;
      state: OpenCodeLaneTurnState;
    }): void;
    logger: { warn(message: string): void };
  }
): void {
  const { teamName, memberName, laneId, state } = input;
  openCodeLaneTurnActivityRegistry.note({
    teamName,
    memberName,
    laneId,
    state,
    observedAt: input.observedAt,
  });
  if (!input.isLeadRecipient || !ports.notifyLeadTurnActivity) {
    return;
  }
  try {
    ports.notifyLeadTurnActivity({ teamName, memberName, laneId, state });
  } catch (error) {
    ports.logger.warn(
      `[${teamName}] OpenCode lead turn activity (${state}) notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
