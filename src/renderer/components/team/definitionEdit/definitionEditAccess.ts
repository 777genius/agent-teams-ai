export type DefinitionEditUnavailableKey =
  | 'detail.tooltips.editUnavailableProvisioning'
  | 'detail.tooltips.editUnavailableRunningProject';

export interface DefinitionEditAccess {
  /** Show the edit controls at all. */
  canEdit: boolean;
  /** When set, the controls are visible but disabled, with this explanation. */
  unavailableKey: DefinitionEditUnavailableKey | null;
}

/**
 * Edit controls of the team screen.
 * - a read-only retained copy never edits;
 * - an ordinary team and a per-project team edit the same way (a per-project
 *   team edits its logical definition);
 * - while provisioning, or while a per-project team runs (the main process
 *   refuses edits while any project runs), the controls explain why they are off.
 */
export function getDefinitionEditAccess(input: {
  retainedHistory: boolean;
  logicalTeamName?: string;
  isAlive: boolean;
  isProvisioning: boolean;
}): DefinitionEditAccess {
  if (input.retainedHistory) return { canEdit: false, unavailableKey: null };
  if (input.isProvisioning) {
    return { canEdit: true, unavailableKey: 'detail.tooltips.editUnavailableProvisioning' };
  }
  if (input.logicalTeamName && input.isAlive) {
    return { canEdit: true, unavailableKey: 'detail.tooltips.editUnavailableRunningProject' };
  }
  return { canEdit: true, unavailableKey: null };
}
