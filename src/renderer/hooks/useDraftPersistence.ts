import { useCallback, useEffect, useRef, useState } from 'react';

import { draftStorage } from '@renderer/services/draftStorage';

interface UseDraftPersistenceOptions {
  key: string;
  initialValue?: string;
  enabled?: boolean;
  debounceMs?: number;
}

interface UseDraftPersistenceResult {
  value: string;
  setValue: (v: string) => void;
  isSaved: boolean;
  clearDraft: () => void;
}

export function useDraftPersistence({
  key,
  initialValue,
  enabled = true,
  debounceMs = 500,
}: UseDraftPersistenceOptions): UseDraftPersistenceResult {
  const [value, setValueState] = useState(initialValue ?? '');
  const [isSaved, setIsSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  // Load draft on mount
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    void (async () => {
      const draft = await draftStorage.loadDraft(key);
      if (cancelled) return;
      if (draft != null && initialValue == null) {
        setValueState(draft);
        setIsSaved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [key, enabled]);

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current != null) {
      const val = pendingValueRef.current;
      pendingValueRef.current = null;
      if (val.length === 0) {
        void draftStorage.deleteDraft(keyRef.current);
      } else {
        void draftStorage.saveDraft(keyRef.current, val);
      }
    }
  }, []);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  const setValue = useCallback(
    (v: string) => {
      setValueState(v);
      setIsSaved(false);

      if (!enabled) return;

      pendingValueRef.current = v;

      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingValueRef.current;
        pendingValueRef.current = null;
        if (pending == null) return;

        if (pending.length === 0) {
          void draftStorage.deleteDraft(keyRef.current);
        } else {
          void draftStorage.saveDraft(keyRef.current, pending).then(() => {
            setIsSaved(true);
          });
        }
      }, debounceMs);
    },
    [enabled, debounceMs]
  );

  const clearDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingValueRef.current = null;
    setValueState('');
    setIsSaved(false);
    if (enabled) {
      void draftStorage.deleteDraft(keyRef.current);
    }
  }, [enabled]);

  return { value, setValue, isSaved, clearDraft };
}
