import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { isImeComposing } from '@renderer/utils/imeComposition';
import { Loader2, Search } from 'lucide-react';

export interface DashboardCommandPaletteProps<Row> {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  modeKey: string;
  title: string;
  description: string;
  modeLabel: React.ReactNode;
  placeholder: string;
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  renderRow: (row: Row, index: number, selected: boolean, onClick: () => void) => React.ReactNode;
  onSelect: (row: Row) => void;
  empty: React.ReactNode;
  error?: React.ReactNode;
  footer: React.ReactNode;
  headerAction?: React.ReactNode;
  loading?: boolean;
  focusInput?: boolean;
  onShortcutG?: () => void;
}

/** Browser-safe palette shell used by Desktop session search and Hosted navigation. */
export const DashboardCommandPalette = <Row,>({
  open,
  onClose,
  query,
  onQueryChange,
  modeKey,
  title,
  description,
  modeLabel,
  placeholder,
  rows,
  getRowKey,
  renderRow,
  onSelect,
  empty,
  error,
  footer,
  headerAction,
  loading = false,
  focusInput = true,
  onShortcutG,
}: DashboardCommandPaletteProps<Row>): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const previousModeKeyRef = useRef(modeKey);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => setSelectedIndex(0), [query, modeKey, rows]);
  useEffect(() => {
    if (previousModeKeyRef.current !== modeKey) {
      previousModeKeyRef.current = modeKey;
      if (open && focusInput) inputRef.current?.focus();
    }
  }, [open, modeKey, focusInput]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (isImeComposing(event)) return;
      if (onShortcutG && event.code === 'KeyG' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onShortcutG();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => (rows.length ? Math.min(index + 1, rows.length - 1) : 0));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === 'Enter') {
        const row = rows[selectedIndex];
        if (row) {
          event.preventDefault();
          onSelect(row);
        }
      }
    },
    [onSelect, onShortcutG, rows, selectedIndex]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        className="max-w-2xl gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          previouslyFocusedRef.current =
            active instanceof HTMLElement &&
            active !== document.body &&
            !active.closest('[role="dialog"]')
              ? active
              : null;
          event.preventDefault();
          if (focusInput) inputRef.current?.focus();
          else contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const previous = previouslyFocusedRef.current;
          previouslyFocusedRef.current = null;
          if (previous?.isConnected && !previous.hasAttribute('disabled')) previous.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Radix's dismissable layer sees Escape before the input handler.
          // eslint-disable-next-line sonarjs/deprecation -- keyCode 229 is the IME fallback.
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <div className="bg-surface-raised/50 flex items-center justify-between gap-2 border-b border-border py-2 pl-4 pr-14">
          <div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">{modeLabel}</div>
          {headerAction}
        </div>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-5 shrink-0 text-text-muted" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label={title}
            className="h-auto flex-1 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
          />
          {loading && <Loader2 className="size-4 animate-spin text-text-muted" />}
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {error ? (
            <div role="alert" className="px-4 py-8 text-center text-sm text-text-muted">
              {error}
            </div>
          ) : rows.length ? (
            <div className="py-2">
              {rows.map((row, index) => (
                <React.Fragment key={getRowKey(row)}>
                  {renderRow(row, index, index === selectedIndex, () => onSelect(row))}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-text-muted">{empty}</div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-text-muted">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
};
