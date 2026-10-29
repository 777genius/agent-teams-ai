import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  findTaskReferenceMatches,
  parseTaskLinkHref,
} from '@renderer/utils/taskReferenceUtils';

import { hostTeamSelectionKey } from './hostTeamRouting';

import type { BackendConnectionSnapshot } from '../contracts/connections';

type Bindings = BackendConnectionSnapshot['bindings'];
const resourceReference = /^host-ref:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;

/** Metadata identity only. No reference grants permission to read or mutate another Team. */
export function storeHostTaskReferenceTeam(
  team: string | undefined,
  canonical: string,
  selection: string,
  bindings: Bindings
): string | undefined {
  if (team === undefined || team === selection) return canonical;
  const source = bindings.find((row) => hostTeamSelectionKey(row.handle.handleId) === selection);
  const target = bindings.find((row) => hostTeamSelectionKey(row.handle.handleId) === team);
  if (
    !source?.ownerResourceRef ||
    target?.ownerResourceRef !== source.ownerResourceRef ||
    !target.teamResourceRef ||
    !resourceReference.test(`host-ref:${target.teamResourceRef}`)
  )
    return undefined;
  return `host-ref:${target.teamResourceRef}`;
}

/** Reuses the app's task-reference codec so textual identities cannot escape owner routing. */
export function translateHostTaskReferences(
  text: string,
  mapTeam: (team?: string) => string
): string {
  let result = text;
  const encoded = findTaskReferenceMatches(text, []).filter((match) => match.encoded);
  for (const match of encoded.reverse()) {
    const { taskId, teamName } = match.suggestion;
    if (!taskId) continue;
    result =
      result.slice(0, match.start) +
      createEncodedTaskReference(match.ref, taskId, mapTeam(teamName)) +
      result.slice(match.end);
  }
  return result.replace(/task:\/\/[^\s<>)[\]]+/g, (href) => {
    const ref = parseTaskLinkHref(href);
    if (!ref) throw new Error('Invalid Host task reference');
    return buildTaskLinkHref({
      taskId: ref.taskId,
      displayId: ref.displayId ?? ref.taskId,
      teamName: mapTeam(ref.teamName),
    });
  });
}

/** A captured archive/gap identity is never a live destination or a legacy name. */
export function qualifyHostTaskReferenceTeam(
  team: string | undefined,
  canonical: string,
  selection: string,
  bindings: Bindings = []
): string {
  if (team === undefined || team === canonical) return selection;
  const resource = resourceReference.exec(team)?.[1];
  if (resource) {
    const source = bindings.find((row) => hostTeamSelectionKey(row.handle.handleId) === selection);
    const targets = source?.ownerResourceRef
      ? bindings.filter(
          (row) =>
            row.ownerResourceRef === source.ownerResourceRef && row.teamResourceRef === resource
        )
      : [];
    if (targets.length === 1) return hostTeamSelectionKey(targets[0].handle.handleId);
    // The exact retired reference never resolves by a replacement's equal display/canonical name.
    return `${selection}:unbound:${encodeURIComponent(team)}`;
  }
  if (/^legacy-(archive|gap):[a-f0-9]{64}$/.test(team))
    return `${selection}:source-${team.startsWith('legacy-gap:') ? 'gap' : 'archive'}:${encodeURIComponent(team)}`;
  return `${selection}:unbound:${encodeURIComponent(team)}`;
}
