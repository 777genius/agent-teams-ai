import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_PREFIX = 'kanban-column-widths:';
const MIN_COLUMN_WIDTH = 180;
const DEFAULT_COLUMN_WIDTH = 256; // w-64

interface UseResizableColumnsOptions {
  /** Storage key suffix (e.g. teamName). */
  storageKey: string;
  /** Column IDs in display order. */
  columnIds: string[];
}

interface UseResizableColumnsResult {
  /** Width in px for each column ID. */
  widths: Map<string, number>;
  /** Props to spread on the drag handle between columns. */
  getHandleProps: (leftColumnId: string) => {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
    'aria-label': string;
  };
}

function loadWidths(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && v >= MIN_COLUMN_WIDTH) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveWidths(key: string, widths: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(widths));
  } catch {
    // Quota exceeded — ignore
  }
}

export function useResizableColumns({
  storageKey,
  columnIds,
}: UseResizableColumnsOptions): UseResizableColumnsResult {
  const [widthRecord, setWidthRecord] = useState<Record<string, number>>(() =>
    loadWidths(storageKey)
  );

  // Re-read from localStorage when storageKey changes
  useEffect(() => {
    setWidthRecord(loadWidths(storageKey));
  }, [storageKey]);

  const draggingRef = useRef<{
    leftId: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const widths = new Map<string, number>();
  for (const id of columnIds) {
    widths.set(id, widthRecord[id] ?? DEFAULT_COLUMN_WIDTH);
  }

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const delta = e.clientX - drag.startX;
    const newWidth = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + delta);
    setWidthRecord((prev) => ({ ...prev, [drag.leftId]: newWidth }));
  }, []);

  const handlePointerUp = useCallback(() => {
    const drag = draggingRef.current;
    if (!drag) return;
    draggingRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist
    setWidthRecord((current) => {
      saveWidths(storageKey, current);
      return current;
    });
  }, [storageKey]);

  // Safety: if the board unmounts or storageKey changes mid-drag, clean up global listeners/styles.
  useEffect(() => {
    return () => {
      draggingRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const getHandleProps = useCallback(
    (leftColumnId: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        const currentWidth = widthRecord[leftColumnId] ?? DEFAULT_COLUMN_WIDTH;
        draggingRef.current = {
          leftId: leftColumnId,
          startX: e.clientX,
          startWidth: currentWidth,
        };
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        document.addEventListener('pointermove', handlePointerMove, { signal: ac.signal });
        document.addEventListener('pointerup', handlePointerUp, { signal: ac.signal });
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      },
      style: {
        cursor: 'col-resize' as const,
        width: 8,
        flexShrink: 0,
        alignSelf: 'stretch' as const,
      },
      'aria-label': `Resize column ${leftColumnId}`,
    }),
    [widthRecord, handlePointerMove, handlePointerUp]
  );

  return { widths, getHandleProps };
}
