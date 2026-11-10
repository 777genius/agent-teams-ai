import { useCallback, useState } from 'react';

/**
 * Manages collapsed/expanded state for group headers with localStorage persistence.
 * Each grouping mode gets a unique prefix to avoid key collisions.
 */

const STORAGE_PREFIX = 'taskGroupCollapsed';

function storageKey(prefix: string, groupKey: string): string {
  return `${STORAGE_PREFIX}:${prefix}:${groupKey}`;
}

function loadCollapsedSet(prefix: string, groupKeys: string[]): Set<string> {
  const set = new Set<string>();
  try {
    for (const key of groupKeys) {
      if (localStorage.getItem(storageKey(prefix, key)) === '1') {
        set.add(key);
      }
    }
  } catch {
    /* ignore storage errors */
  }
  return set;
}

export function useCollapsedGroups(prefix: string, groupKeys: string[]) {
  // Re-initialize when prefix or keys change
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadCollapsedSet(prefix, groupKeys)
  );

  // Sync with new keys when they change (e.g. new projects appear)
  // We use a key string to detect changes without deep comparison
  const keysFingerprint = groupKeys.join('\0');
  const [prevFingerprint, setPrevFingerprint] = useState(keysFingerprint);
  const [prevPrefix, setPrevPrefix] = useState(prefix);

  if (keysFingerprint !== prevFingerprint || prefix !== prevPrefix) {
    setPrevFingerprint(keysFingerprint);
    setPrevPrefix(prefix);
    setCollapsed(loadCollapsedSet(prefix, groupKeys));
  }

  const isCollapsed = useCallback((groupKey: string) => collapsed.has(groupKey), [collapsed]);

  const toggle = useCallback(
    (groupKey: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        const key = storageKey(prefix, groupKey);
        try {
          if (next.has(groupKey)) {
            next.delete(groupKey);
            localStorage.removeItem(key);
          } else {
            next.add(groupKey);
            localStorage.setItem(key, '1');
          }
        } catch {
          /* ignore storage errors */
        }
        return next;
      });
    },
    [prefix]
  );

  return { isCollapsed, toggle } as const;
}
