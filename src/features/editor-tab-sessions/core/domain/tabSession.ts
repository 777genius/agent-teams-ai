import {
  isWindowsishPath,
  normalizePathForComparison,
  stripTrailingSeparators,
} from '@shared/utils/platformPath';

export interface EditorTabSession {
  paths: string[];
  active: string | null;
}
export interface StoredEditorTabSession extends EditorTabSession {
  project: string;
}
export const MAX_SESSION_TABS = 64;
export const MAX_SESSION_PROJECTS = 32;
export const MAX_SESSION_STORAGE_BYTES = 512 * 1024;

/** Filesystem-only identity; never turn a relative path or URI into an absolute path. */
export function editorSessionPathKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0'))
    return null;
  const path = value.replace(/\\/g, '/');
  const windows = isWindowsishPath(path);
  const segments = path.split('/');
  let root: string;
  let start: number;
  if (/^[A-Za-z]:\//.test(path)) {
    root = segments[0] + '/';
    start = 1;
  } else if (path.startsWith('//')) {
    if (
      [segments[2], segments[3]].some(
        (part) => !part || ['.', '..', '?'].includes(part) || part.includes(':')
      )
    )
      return null;
    root = '//' + segments[2] + '/' + segments[3] + '/';
    start = 4;
  } else if (path.startsWith('/')) {
    root = '/';
    start = 1;
  } else return null;
  const parts: string[] = [];
  for (const part of segments.slice(start)) {
    if (!part || part === '.') continue;
    if (windows && part.includes(':')) return null;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return stripTrailingSeparators(normalizePathForComparison(root + parts.join('/')));
}

export function normalizeEditorTabSession(project: string, input: unknown): EditorTabSession {
  const root = editorSessionPathKey(project);
  const value = input as Partial<EditorTabSession> | null;
  const paths: string[] = [];
  const keys = new Set<string>();
  let bytes = 0;
  if (root && value && Array.isArray(value.paths)) {
    for (const file of value.paths.slice(0, MAX_SESSION_TABS)) {
      const key = editorSessionPathKey(file);
      if (
        !key ||
        key === root ||
        !key.startsWith(root.endsWith('/') ? root : root + '/') ||
        keys.has(key)
      )
        continue;
      bytes += file.length;
      if (bytes > 16 * 1024) break;
      keys.add(key);
      paths.push(file);
    }
  }
  const activeKey = editorSessionPathKey(value?.active);
  return {
    paths,
    active: paths.find((file) => editorSessionPathKey(file) === activeKey) ?? paths[0] ?? null,
  };
}

export function decodeEditorTabSessions(raw: string | null): StoredEditorTabSession[] {
  if (!raw || raw.length > MAX_SESSION_STORAGE_BYTES) return [];
  try {
    const value = JSON.parse(raw) as { version?: unknown; projects?: unknown };
    if (value?.version !== 1 || !Array.isArray(value.projects)) return [];
    const seen = new Set<string>();
    return value.projects.slice(-MAX_SESSION_PROJECTS).flatMap((entry: unknown) => {
      const project = (entry as { project?: unknown } | null)?.project;
      const key = editorSessionPathKey(project);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [{ project: key, ...normalizeEditorTabSession(key, entry) }];
    });
  } catch {
    return [];
  }
}
