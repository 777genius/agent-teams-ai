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

/** Read the current renderer-only creation settings, including the edit fence. */
export function readCreateTeamAdvancedSession(): Readonly<AdvancedCreateSession> | null {
  return advancedSession;
}

/** Replace untouched Advanced CLI settings with the selected team's stored defaults. */
export function restoreCreateTeamAdvancedDefaults(
  worktreeEnabled: boolean,
  worktreeName: string,
  customArgs: string
): void {
  advancedSession = { worktreeEnabled, worktreeName, customArgs, edited: false };
}

/** Keep explicit Advanced CLI edits alive across creation-page component remounts. */
export function patchCreateTeamAdvancedSession(
  patch: Partial<Omit<AdvancedCreateSession, 'edited'>>
): void {
  advancedSession = {
    worktreeEnabled: false, worktreeName: '', customArgs: '',
    ...(advancedSession ?? {}), ...patch, edited: true,
  };
}

/** Read the generation used to invalidate stale create-team writes. */
export function currentCreateTeamDraftGeneration(): number {
  return generation;
}

/** Check that a pending draft operation still belongs to the active generation. */
export function isCreateTeamDraftGenerationCurrent(expected: number): boolean {
  return generation === expected;
}

/** Invalidate pending saves and clear volatile Advanced CLI edits after retirement. */
export function retireCreateTeamDraftGeneration(): void {
  generation += 1;
  advancedSession = null;
}
