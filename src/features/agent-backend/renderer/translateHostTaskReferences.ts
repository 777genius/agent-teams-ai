import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  findTaskReferenceMatches,
  parseTaskLinkHref,
} from '@renderer/utils/taskReferenceUtils';

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
      // Existing app href parser decodes the URLSearchParams value once more.
      teamName: encodeURIComponent(mapTeam(ref.teamName)),
    });
  });
}

/** A captured archive/gap identity is never a live destination or a legacy name. */
export function qualifyHostTaskReferenceTeam(
  team: string | undefined,
  canonical: string,
  selection: string
): string {
  if (team === undefined || team === canonical) return selection;
  if (/^legacy-(archive|gap):[a-f0-9]{64}$/.test(team))
    return `${selection}:source-${team.startsWith('legacy-gap:') ? 'gap' : 'archive'}:${encodeURIComponent(team)}`;
  return `${selection}:unbound:${encodeURIComponent(team)}`;
}
