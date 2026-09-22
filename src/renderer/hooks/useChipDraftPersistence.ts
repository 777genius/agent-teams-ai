/**
 * Draft persistence for InlineChip arrays.
 *
 * Uses the same draftStorage (IndexedDB + fallback) as useDraftPersistence,
 * serializing chips as JSON strings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { draftStorage } from '@renderer/services/draftStorage';

import type { InlineChip } from '@renderer/types/inlineChip';

interface UseChipDraftResult {
  chips: InlineChip[];
  /** Accepts a direct value (not a callback). Saves to draftStorage with debounce. */
  setChips: (chips: InlineChip[]) => void;
  /** Append a single chip. Safe for passing directly as onFileChipInsert. */
  addChip: (chip: InlineChip) => void;
  /** Remove a chip by id. Safe for passing directly as onChipRemove. */
  removeChip: (chipId: string) => void;
  clearChipDraft: () => void;
  isSaved: boolean;
}

const DEBOUNCE_MS = 500;

function isValidChipArray(data: unknown): data is InlineChip[] {
  if (!Array.isArray(data)) return false;
  return data.every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const item = raw as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.filePath === 'string' &&
      typeof item.fileName === 'string' &&
      (typeof item.fromLine === 'number' || item.fromLine === null) &&
      (typeof item.toLine === 'number' || item.toLine === null) &&
      typeof item.codeText === 'string' &&
      typeof item.language === 'string'
    );
  });
}

export function useChipDraftPersistence(key: string): UseChipDraftResult {
  const [chips, setChipsState] = useState<InlineChip[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: string; value: InlineChip[] } | null>(null);
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
  }, [key]);
  // Ref for current chips — allows addChip/removeChip to read latest value
  // without stale closures, using the same sync-ref pattern as keyRef.
  const chipsRef = useRef<InlineChip[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending.value.length === 0) {
        void draftStorage.deleteDraft(pending.key);
      } else {
        void draftStorage.saveDraft(pending.key, JSON.stringify(pending.value));
      }
    }
  }, []);

  // Load on mount / key change
  useEffect(() => {
    let cancelled = false;
    // Flush any pending debounced save for the previous key and reset local state for the new key.
    flushPending();
    chipsRef.current = [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on key change before async load
    setChipsState([]);

    setIsSaved(false);
    void (async () => {
      const raw = await draftStorage.loadDraft(key);
      if (cancelled || raw == null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isValidChipArray(parsed)) {
          chipsRef.current = parsed;
          setChipsState(parsed);
          setIsSaved(true);
        }
      } catch {
        // Invalid JSON — ignore, start with empty array
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, flushPending]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  const setChips = useCallback((nextChips: InlineChip[]) => {
    chipsRef.current = nextChips;
    setChipsState(nextChips);
    setIsSaved(false);
    pendingRef.current = { key: keyRef.current, value: nextChips };

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      if (pending.value.length === 0) {
        void draftStorage.deleteDraft(pending.key);
      } else {
        void draftStorage.saveDraft(pending.key, JSON.stringify(pending.value)).then(() => {
          if (mountedRef.current) setIsSaved(true);
        });
      }
    }, DEBOUNCE_MS);
  }, []);

  const addChip = useCallback(
    (chip: InlineChip) => {
      setChips([...chipsRef.current, chip]);
    },
    [setChips]
  );

  const removeChip = useCallback(
    (chipId: string) => {
      setChips(chipsRef.current.filter((c) => c.id !== chipId));
    },
    [setChips]
  );

  const clearChipDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    chipsRef.current = [];
    setChipsState([]);
    setIsSaved(false);
    void draftStorage.deleteDraft(keyRef.current);
  }, []);

  return { chips, setChips, addChip, removeChip, clearChipDraft, isSaved };
}
