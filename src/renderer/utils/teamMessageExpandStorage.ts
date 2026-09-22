const STORAGE_PREFIX = 'team-msg-expanded:';

function storageKey(teamName: string): string {
  return `${STORAGE_PREFIX}${teamName}`;
}

export function getExpandedOverrides(teamName: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(teamName));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function addExpanded(teamName: string, messageKey: string): void {
  try {
    const set = getExpandedOverrides(teamName);
    if (set.has(messageKey)) return;
    set.add(messageKey);
    localStorage.setItem(storageKey(teamName), JSON.stringify([...set]));
  } catch {
    // quota or disabled
  }
}

export function removeExpanded(teamName: string, messageKey: string): void {
  try {
    const set = getExpandedOverrides(teamName);
    if (!set.has(messageKey)) return;
    set.delete(messageKey);
    localStorage.setItem(storageKey(teamName), JSON.stringify([...set]));
  } catch {
    // quota or disabled
  }
}
