const KEY_PREFIX = 'agent-teams:task-table:v1:';
const COLUMN_IDS = new Set(['task', 'status', 'owner', 'blockedByCount', 'updatedAt', 'commentCount']);

export interface TaskTablePreferences {
  visibility: Record<string, boolean>;
  sizing: Record<string, number>;
}

export function taskTablePreferenceKey(contextId: string, teamName: string): string {
  return KEY_PREFIX + JSON.stringify([contextId, teamName]);
}

export function loadTaskTablePreferences(key: string): TaskTablePreferences {
  const empty = (): TaskTablePreferences => ({ visibility: {}, sizing: {} });
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 4096) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
    const record = parsed as Record<string, unknown>;
    const result = empty();
    if (record.visibility && typeof record.visibility === 'object') {
      for (const [id, value] of Object.entries(record.visibility)) {
        if (COLUMN_IDS.has(id) && id !== 'task' && typeof value === 'boolean') {
          result.visibility[id] = value;
        }
      }
    }
    if (record.sizing && typeof record.sizing === 'object') {
      for (const [id, value] of Object.entries(record.sizing)) {
        if (COLUMN_IDS.has(id) && typeof value === 'number' && Number.isFinite(value)) {
          result.sizing[id] = Math.min(720, Math.max(64, Math.round(value)));
        }
      }
    }
    return result;
  } catch {
    return empty();
  }
}

export function saveTaskTablePreferences(key: string, preferences: TaskTablePreferences): void {
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    // Preference persistence is best-effort; it must never break the task board.
  }
}
