import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendConnectionSnapshot } from '../contracts/connections';

export type HostProjectConnection = BackendConnectionSnapshot['bindings'][number];
const fail = (): never => { throw new HostTeamOperationError('project-family-unavailable', 'not-dispatched'); };
const proof = (row: HostProjectConnection) => ({ handleId: row.handle.handleId,
  ownerResourceRef: row.ownerResourceRef, teamResourceRef: row.teamResourceRef,
  projectContextMode: row.projectContextMode, projectContext: row.projectContext });

/** Navigation metadata is cloned before awaits; every effect still uses the captured Host handle. */
export function captureHostProjectFamily(snapshot: BackendConnectionSnapshot, selection: string) {
  if (snapshot.state !== 'ready') return fail();
  const bindings = structuredClone(snapshot.bindings), handleId = parseHostTeamSelectionKey(selection);
  const select = (id: string) => {
    const matches = bindings.filter(row => row.handle.handleId === id);
    if (matches.length !== 1) return fail();
    return matches[0]!;
  };
  const selected = select(handleId);
  const logical = selected.projectContext ? select(selected.projectContext.logicalHandleId) : selected;
  if (logical.projectContext) return fail();
  const children = bindings.filter(row => row.projectContext?.logicalHandleId === logical.handle.handleId)
    .sort((a, b) => a.handle.handleId.localeCompare(b.handle.handleId));
  if (children.length > 128 || new Set(children.map(row => row.handle.handleId)).size !== children.length) return fail();
  if (children.length || logical.projectContextMode === 'per_project') {
    if (!logical.ownerResourceRef || !logical.teamResourceRef) return fail();
    for (const child of children) {
      if (child.handle.handleId === logical.handle.handleId || !child.teamResourceRef ||
        child.teamResourceRef === logical.teamResourceRef || child.ownerResourceRef !== logical.ownerResourceRef ||
        !child.projectContext?.projectPath || !child.projectContext.workContextId) return fail();
    }
  }
  if (snapshot.unavailableOwners?.some(owner => owner.ownerResourceRef === logical.ownerResourceRef)) return fail();
  const targets = selected.projectContext ? [selected] : [logical, ...children];
  const signature = JSON.stringify([proof(logical), ...children.map(proof)]);
  return { bindings, selected, logical, children, targets, signature,
    assertSame(next: BackendConnectionSnapshot): void {
      if (captureHostProjectFamily(next, selection).signature !== signature) fail();
    } };
}
