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
  const pendingRef = useRef<InlineChip[] | null>(null);
  const keyRef = useRef(key);
  // eslint-disable-next-line react-hooks/refs -- sync ref with prop for stable callbacks
  keyRef.current = key;

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await draftStorage.loadDraft(key);
      if (cancelled || raw == null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isValidChipArray(parsed)) {
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
  }, [key]);

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const val = pendingRef.current;
      pendingRef.current = null;
      if (val.length === 0) {
        void draftStorage.deleteDraft(keyRef.current);
      } else {
        void draftStorage.saveDraft(keyRef.current, JSON.stringify(val));
      }
    }
  }, []);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  const setChips = useCallback((nextChips: InlineChip[]) => {
    setChipsState(nextChips);
    setIsSaved(false);
    pendingRef.current = nextChips;

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      if (pending.length === 0) {
        void draftStorage.deleteDraft(keyRef.current);
      } else {
        void draftStorage.saveDraft(keyRef.current, JSON.stringify(pending)).then(() => {
          setIsSaved(true);
        });
      }
    }, DEBOUNCE_MS);
  }, []);

  const clearChipDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setChipsState([]);
    setIsSaved(false);
    void draftStorage.deleteDraft(keyRef.current);
  }, []);

  return { chips, setChips, clearChipDraft, isSaved };
}
