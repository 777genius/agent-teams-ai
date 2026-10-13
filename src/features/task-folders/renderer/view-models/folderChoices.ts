import { parentOf } from '../../core/domain/folders';

import type { Snapshot } from '../../core/domain/folders';
/** Paths distinguish equal names in different branches; sibling ordinals distinguish equal names in one branch. */
export function folderChoices(snapshot: Snapshot): { id: string; label: string }[] {
  const folders = new Map(
    snapshot.folders.map((folder) => [folder.id, folder] as const)
  );
  const siblingIds = (parent: string | null): string[] =>
    parent === null
      ? snapshot.rootFolderIds
      : (folders.get(parent)?.children ?? []).flatMap((child) =>
          child.kind === 'folder' ? [child.id] : []
        );
  const segment = (id: string): string => {
    const folder = folders.get(id)!;
    const parent = parentOf(snapshot, id);
    const siblings = siblingIds(parent)
      .map((siblingId) => folders.get(siblingId)!)
      .filter((sibling) => sibling.name === folder.name);
    return siblings.length > 1
      ? `${folder.name} (${siblings.findIndex((row) => row.id === id) + 1})`
      : folder.name;
  };
  const ordered: { id: string; label: string }[] = [];
  const appendFolder = (folder: { id: string }): void => {
    const parts = [segment(folder.id)];
    let parent = parentOf(snapshot, folder.id);
    while (parent) {
      parts.unshift(segment(parent));
      parent = parentOf(snapshot, parent);
    }
    ordered.push({ id: folder.id, label: parts.join(' / ') });
    siblingIds(folder.id).forEach((id) => appendFolder({ id }));
  };
  snapshot.rootFolderIds.forEach((id) => appendFolder({ id }));
  return ordered;
}
