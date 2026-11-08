/**
 * In-memory generation fence for one creation draft in this renderer.
 *
 * A retired editor must never write an older debounced snapshot after a
 * deliberate replacement or a successful creation. This does not persist
 * credentials or change the launch dialog's storage lifecycle.
 */
let generation = 0;

/** Create-only, in-memory Advanced CLI edits; never copied into persisted draft storage. */
interface AdvancedCreateSession {
  worktreeEnabled: boolean;
  worktreeName: string;
  customArgs: string;
  edited: boolean;
}

let advancedSession: AdvancedCreateSession | null = null;

export function readCreateTeamAdvancedSession(): Readonly<AdvancedCreateSession> | null {
  return advancedSession;
}

export function restoreCreateTeamAdvancedDefaults(
  worktreeEnabled: boolean,
  worktreeName: string,
  customArgs: string
): void {
  advancedSession = { worktreeEnabled, worktreeName, customArgs, edited: false };
}

export function patchCreateTeamAdvancedSession(
  patch: Partial<Omit<AdvancedCreateSession, 'edited'>>
): void {
  advancedSession = {
    worktreeEnabled: false, worktreeName: '', customArgs: '',
    ...advancedSession, ...patch, edited: true,
  };
}

export function currentCreateTeamDraftGeneration(): number {
  return generation;
}

export function isCreateTeamDraftGenerationCurrent(expected: number): boolean {
  return generation === expected;
}

export function retireCreateTeamDraftGeneration(): void {
  generation += 1;
  advancedSession = null;
}
