import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';

const MAX_PROJECTS = 4096;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

function directory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

/** Read-only selected namespace lookup; never reproduces SDK project-key hashing or reads ambient HOME. */
export function claudeSessionExists(namespace: string, cwd: string, sessionId: string): boolean {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId) || !directory(namespace) || !directory(cwd)) return false;
  const projects = join(namespace, 'projects');
  if (!directory(projects)) return false;
  try {
    const rows = readdirSync(projects, { withFileTypes: true });
    if (rows.length > MAX_PROJECTS) return false;
    let found = false;
    for (const row of rows) {
      if (!row.isDirectory() || row.isSymbolicLink()) continue;
      const project = join(projects, row.name);
      if (!directory(project)) return false;
      const file = join(project, `${sessionId}.jsonl`);
      let exists = false;
      try {
        lstatSync(file);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      if (!exists) continue;
      if (found || !selectedTranscript(file, cwd, sessionId)) return false;
      found = true;
    }
    return found;
  } catch {
    return false;
  }
}

function selectedTranscript(path: string, cwd: string, sessionId: string): boolean {
  if (realpathSync(path) !== path) return false;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_HISTORY_BYTES) return false;
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let total = 0;
    let matched = false;
    const line = (bytes: Buffer): boolean => {
      if (!bytes.length) return true;
      if (bytes.length > MAX_LINE_BYTES) return false;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      if (item.type !== 'user' && item.type !== 'assistant') return true;
      if (item.isSidechain === true) return true;
      if (item.sessionId !== sessionId || item.isSidechain !== false) return false;
      // Native cwd can change later; require positive origin proof without rejecting that history.
      if (item.cwd === cwd) matched = true;
      return true;
    };
    for (;;) {
      const count = readSync(fd, chunk);
      if (!count) break;
      total += count;
      if (total > MAX_HISTORY_BYTES) return false;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        if (!line(pending.subarray(0, end))) return false;
        pending = pending.subarray(end + 1);
      }
      if (pending.length > MAX_LINE_BYTES) return false;
    }
    if (pending.length && !line(pending)) return false;
    const after = fstatSync(fd);
    const current = lstatSync(path);
    return (
      matched &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      current.dev === after.dev &&
      current.ino === after.ino
    );
  } finally {
    closeSync(fd);
  }
}
