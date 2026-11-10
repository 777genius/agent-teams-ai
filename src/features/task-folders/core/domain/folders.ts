export interface TaskIdentity {
  teamName: string;
  taskId: string;
}
export type Child = { kind: 'folder'; id: string } | { kind: 'task'; identity: TaskIdentity };
export interface Folder {
  id: string;
  name: string;
  children: Child[];
}
export interface Snapshot {
  version: 1;
  revision: number;
  rootFolderIds: string[];
  folders: Folder[];
}
export type Anchor = { before: Child } | { append: true };
export const append: Anchor = { append: true };
export const emptySnapshot = (): Snapshot => ({
  version: 1,
  revision: 0,
  rootFolderIds: [],
  folders: [],
});
export const DEFAULT_FOLDER_ID = 'my-first-folder';
export const DEFAULT_FOLDER_NAME = 'My First Folder';
/** First-run organization: one starter folder so tasks always have a home to move into. */
export const seededSnapshot = (): Snapshot => ({
  version: 1,
  revision: 1,
  rootFolderIds: [DEFAULT_FOLDER_ID],
  folders: [{ id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME, children: [] }],
});
export const taskKey = (identity: TaskIdentity): string =>
  JSON.stringify([identity.teamName, identity.taskId]);
export const childKey = (child: Child): string =>
  child.kind === 'folder' ? `folder:${child.id}` : `task:${taskKey(child.identity)}`;
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error('name');
  return trimmed;
}
export function isIdentity(value: unknown): value is TaskIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as TaskIdentity;
  return (
    typeof v.teamName === 'string' &&
    v.teamName.length > 0 &&
    typeof v.taskId === 'string' &&
    v.taskId.length > 0
  );
}
export function validateSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== 'object') throw new Error('corrupt');
  const s = value as Snapshot;
  if (Number.isSafeInteger(s.version) && s.version > 1) throw new Error('unsupported-version');
  if (s.version !== 1) throw new Error('corrupt');
  if (
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    !Array.isArray(s.rootFolderIds) ||
    !Array.isArray(s.folders)
  )
    throw new Error('corrupt');
  const folders = new Map<string, Folder>();
  for (const f of s.folders) {
    if (
      !f ||
      typeof f.id !== 'string' ||
      !f.id ||
      folders.has(f.id) ||
      typeof f.name !== 'string' ||
      validateName(f.name) !== f.name ||
      !Array.isArray(f.children)
    )
      throw new Error('corrupt');
    folders.set(f.id, f);
  }
  const visited = new Set<string>();
  const tasks = new Set<string>();
  const visit = (id: string): void => {
    const f = folders.get(id);
    if (!f || visited.has(id)) throw new Error('corrupt');
    visited.add(id);
    for (const c of f.children) {
      if (c?.kind === 'folder' && typeof c.id === 'string') visit(c.id);
      else if (c?.kind === 'task' && isIdentity(c.identity)) {
        const key = taskKey(c.identity);
        if (tasks.has(key)) throw new Error('corrupt');
        tasks.add(key);
      } else throw new Error('corrupt');
    }
  };
  s.rootFolderIds.forEach(visit);
  if (visited.size !== folders.size) throw new Error('corrupt');
  return s;
}
export function parentOf(s: Snapshot, id: string): string | null {
  return (
    s.folders.find((f) => f.children.some((c) => c.kind === 'folder' && c.id === id))?.id ?? null
  );
}
export function canMoveFolder(s: Snapshot, id: string, parent: string | null): boolean {
  if (!s.folders.some((f) => f.id === id)) return false;
  if (parent === null) return true;
  const seen = new Set<string>();
  let cursor: string | null = parent;
  while (cursor !== null) {
    if (cursor === id || seen.has(cursor) || !s.folders.some((f) => f.id === cursor)) return false;
    seen.add(cursor);
    cursor = parentOf(s, cursor);
  }
  return true;
}
export type Command =
  | { type: 'create'; id: string; parent: string | null; name: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'moveFolder'; id: string; parent: string | null; anchor: Anchor }
  | { type: 'moveTask'; identity: TaskIdentity; parent: string | null; anchor: Anchor };
export function applyCommand(current: Snapshot, command: Command): Snapshot {
  const s: Snapshot = structuredClone(current);
  const folder = (id: string): Folder => {
    const f = s.folders.find((f) => f.id === id);
    if (!f) throw new Error('missing-folder');
    return f;
  };
  const insert = (parent: string | null, child: Child, anchor: Anchor): void => {
    const children: Child[] =
      parent === null
        ? s.rootFolderIds.map((id) => ({ kind: 'folder', id }))
        : folder(parent).children;
    if (parent === null && child.kind === 'task') return;
    const index =
      'before' in anchor
        ? children.findIndex((c) => childKey(c) === childKey(anchor.before))
        : children.length;
    if (index < 0) throw new Error('missing-anchor');
    children.splice(index, 0, child);
    if (parent === null) s.rootFolderIds = children.map((c) => (c as { id: string }).id);
  };
  const remove = (child: Child): void => {
    s.rootFolderIds = s.rootFolderIds.filter(
      (id) => childKey({ kind: 'folder', id }) !== childKey(child)
    );
    s.folders.forEach((f) => {
      f.children = f.children.filter((c) => childKey(c) !== childKey(child));
    });
  };
  switch (command.type) {
    case 'create': {
      if (!command.id || s.folders.some((f) => f.id === command.id))
        throw new Error('duplicate-folder');
      s.folders.push({ id: command.id, name: validateName(command.name), children: [] });
      insert(command.parent, { kind: 'folder', id: command.id }, append);
      break;
    }
    case 'rename':
      folder(command.id).name = validateName(command.name);
      break;
    case 'moveFolder': {
      if (!canMoveFolder(s, command.id, command.parent)) throw new Error('cycle');
      const child: Child = { kind: 'folder', id: command.id };
      remove(child);
      insert(command.parent, child, command.anchor);
      break;
    }
    case 'moveTask': {
      if (!isIdentity(command.identity)) throw new Error('identity');
      const child: Child = { kind: 'task', identity: command.identity };
      remove(child);
      insert(command.parent, child, command.anchor);
      break;
    }
    case 'delete': {
      const f = folder(command.id);
      const parent = parentOf(s, f.id);
      const children: Child[] =
        parent === null
          ? s.rootFolderIds.map((id) => ({ kind: 'folder', id }))
          : folder(parent).children;
      const index = children.findIndex((c) => c.kind === 'folder' && c.id === f.id);
      children.splice(
        index,
        1,
        ...f.children.filter((c) => parent !== null || c.kind === 'folder')
      );
      if (parent === null) s.rootFolderIds = children.map((c) => (c as { id: string }).id);
      s.folders = s.folders.filter((row) => row.id !== f.id);
      break;
    }
  }
  if (JSON.stringify(s) === JSON.stringify(current)) return current;
  s.revision++;
  return validateSnapshot(s);
}
