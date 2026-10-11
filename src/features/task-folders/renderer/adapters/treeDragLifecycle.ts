import type { DndDataRef, TreeInstance } from '@headless-tree/core';
/** Vendor 1.7.0 has no public cancel operation for foreign HTML drags. Keep this version-specific cleanup at the vendor boundary. */
export function clearTreeDrag<T>(tree: TreeInstance<T>): void {
  const ref = tree.getDataRef<DndDataRef>();
  clearTimeout(ref.current.autoExpandTimeout);
  ref.current.autoExpandTimeout = undefined;
  ref.current.lastDragCode = undefined;
  ref.current.lastAllowDrop = false;
  if (tree.getState().dnd) tree.setState((state) => ({ ...state, dnd: null }));
}
export function cancelHoverExpansion<T>(tree: TreeInstance<T>): void {
  const ref = tree.getDataRef<DndDataRef>();
  clearTimeout(ref.current.autoExpandTimeout);
  ref.current.autoExpandTimeout = undefined;
  ref.current.lastDragCode = undefined;
}
