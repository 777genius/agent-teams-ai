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
  const pendingValueRef = useRef<{ key: string; value: string } | null>(null);
  const keyRef = useRef(key);
  const mountedRef = useRef(true);

  useEffect(() => {
    keyRef.current = key;
  }, [key]);

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
    if (pendingValueRef.current != null) {
      const pending = pendingValueRef.current;
      pendingValueRef.current = null;
      if (pending.value.length === 0) {
        void draftStorage.deleteDraft(pending.key);
      } else {
        void draftStorage.saveDraft(pending.key, pending.value);
      }
    }
  }, []);

  // Load draft on mount / key change
  useEffect(() => {
    let cancelled = false;
    // Prevent debounced saves for the previous key from landing under the new key.
    flushPending();
    // Reset local state for the new key immediately. If a draft exists, it will overwrite below.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on key change before async load
    setValueState(initialValue ?? '');

    setIsSaved(false);

    if (!enabled)
      return () => {
        cancelled = true;
      };
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
  }, [key, enabled, initialValue, flushPending]);

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

      pendingValueRef.current = { key: keyRef.current, value: v };

      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingValueRef.current;
        pendingValueRef.current = null;
        if (pending == null) return;

        if (pending.value.length === 0) {
          void draftStorage.deleteDraft(pending.key);
        } else {
          void draftStorage.saveDraft(pending.key, pending.value).then(() => {
            if (mountedRef.current) setIsSaved(true);
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
