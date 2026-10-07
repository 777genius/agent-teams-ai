import {
  decodeEditorTabSessions,
  editorSessionPathKey,
  MAX_SESSION_PROJECTS,
  MAX_SESSION_STORAGE_BYTES,
  normalizeEditorTabSession,
  type EditorTabSession,
} from '../domain/tabSession';

export interface EditorTabsStorage {
  read(): string | null;
  write(value: string): void;
}
export interface EditorTabsRepository {
  load(project: string): EditorTabSession;
  save(project: string, value: EditorTabSession): void;
}

export function createEditorTabsRepository(storage: EditorTabsStorage): EditorTabsRepository {
  return {
    load(project) {
      const key = editorSessionPathKey(project);
      const saved = decodeEditorTabSessions(storage.read()).find((entry) => entry.project === key);
      return saved ? { paths: saved.paths, active: saved.active } : { paths: [], active: null };
    },
    save(project, value) {
      const key = editorSessionPathKey(project);
      if (!key) return;
      const projects = decodeEditorTabSessions(storage.read()).filter(
        (entry) => entry.project !== key
      );
      projects.push({ project: key, ...normalizeEditorTabSession(key, value) });
      const bounded = projects.slice(-MAX_SESSION_PROJECTS);
      let raw = JSON.stringify({ version: 1, projects: bounded });
      while (raw.length > MAX_SESSION_STORAGE_BYTES && bounded.length > 1) {
        bounded.shift();
        raw = JSON.stringify({ version: 1, projects: bounded });
      }
      storage.write(raw);
    },
  };
}
