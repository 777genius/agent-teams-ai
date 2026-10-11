import { parentOf } from '../../core/domain/folders';

import type { Snapshot } from '../../core/domain/folders';
/** Paths distinguish equal names in different branches; sibling ordinals distinguish equal names in one branch. */
export function folderChoices(snapshot: Snapshot): { id: string; label: string }[] {
  const segment = (id: string): string => {
    const folder = snapshot.folders.find((row) => row.id === id)!;
    const parent = parentOf(snapshot, id);
    const siblings = snapshot.folders.filter(
      (row) => row.name === folder.name && parentOf(snapshot, row.id) === parent
    );
    return siblings.length > 1
      ? `${folder.name} (${siblings.findIndex((row) => row.id === id) + 1})`
      : folder.name;
  };
  return snapshot.folders.map((folder) => {
    const parts = [segment(folder.id)];
    let parent = parentOf(snapshot, folder.id);
    while (parent) {
      parts.unshift(segment(parent));
      parent = parentOf(snapshot, parent);
    }
    return { id: folder.id, label: parts.join(' / ') };
  });
}
