/**
 * In-memory generation fence for one creation draft in this renderer.
 *
 * A retired editor must never write an older debounced snapshot after a
 * deliberate replacement or a successful creation. This does not persist
 * credentials or change the launch dialog's storage lifecycle.
 */
let generation = 0;

export function currentCreateTeamDraftGeneration(): number {
  return generation;
}

export function isCreateTeamDraftGenerationCurrent(expected: number): boolean {
  return generation === expected;
}

export function retireCreateTeamDraftGeneration(): void {
  generation += 1;
}
