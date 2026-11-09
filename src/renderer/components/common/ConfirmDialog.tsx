/**
 * ConfirmDialog - Reusable themed confirmation dialog.
 *
 * Replaces native window.confirm() with a styled modal that matches the app theme.
 * Controlled via useConfirmDialog() hook for imperative usage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useOverlayOccupancy } from '@renderer/hooks/useOverlayOccupancy';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  mode?: 'confirm' | 'info';
}

type ConfirmResolver = ((confirmed: boolean) => void) | null;

const initialState: ConfirmDialogState = {
  isOpen: false,
  title: '',
  message: '',
};

// Singleton state — one dialog at a time
let globalSetState: ((state: ConfirmDialogState) => void) | null = null;
let globalResolver: ConfirmResolver = null;

/**
 * Imperatively show a themed confirm dialog. Returns a promise that resolves
 * to true (confirmed) or false (cancelled).
 *
 * Usage:
 *   const confirmed = await confirm({ title: 'Delete?', message: 'This cannot be undone.' });
 */
// eslint-disable-next-line react-refresh/only-export-components -- imperative API shares singleton state with component
export async function confirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  mode?: 'confirm' | 'info';
  /** An owner may cancel only its own pending confirmation (e.g. editor unmount). */
  signal?: AbortSignal;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (opts.signal?.aborted) {
      resolve(false);
      return;
    }
    // If another confirmation owns the singleton, finish it as canceled.
    globalResolver?.(false);

    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(accepted);
    };
    const onAbort = (): void => {
      // The old owner must not dismiss a newer, unrelated confirmation.
      if (globalResolver !== finish) return;
      globalResolver = null;
      globalSetState?.(initialState);
      finish(false);
    };
    globalResolver = finish;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    globalSetState?.({
      isOpen: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      variant: opts.variant,
      mode: opts.mode,
    });
  });
}

/**
 * ConfirmDialog component. Mount once at the app root (e.g. in App.tsx).
 */
export const ConfirmDialog = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const [state, setState] = useState<ConfirmDialogState>(initialState);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Register singleton setter
  useEffect(() => {
    globalSetState = setState;
    return () => {
      globalSetState = null;
    };
  }, []);

  const close = useCallback((confirmed: boolean) => {
    if (globalResolver) {
      globalResolver(confirmed);
      globalResolver = null;
    }
    setState(initialState);
  }, []);

  // Escape key closes
  useEffect(() => {
    if (!state.isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close(false);
        return;
      }
      // aria-modal must keep Tab inside the confirmation so the background
      // team form cannot be edited during an unresolved destructive action.
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLButtonElement>(
        'button:not([disabled]):not([tabindex="-1"])'
      );
      if (!dialog || !controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      const outside = !dialog.contains(document.activeElement);
      if (e.shiftKey ? outside || document.activeElement === first : outside || document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state.isOpen, close]);

  // Auto-focus confirm button
  useEffect(() => {
    if (state.isOpen && dialogRef.current) {
      const btn = dialogRef.current.querySelector<HTMLButtonElement>('[data-confirm-btn]');
      btn?.focus();
    }
  }, [state.isOpen]);

  useOverlayOccupancy(state.isOpen);

  if (!state.isOpen) return null;

  const isDanger = state.variant === 'danger';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={() => close(false)}
        aria-label={t('actions.closeDialog')}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="relative mx-4 w-full max-w-sm rounded-lg border p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        {/* Icon + Title */}
        <div className="flex items-start gap-3">
          {isDanger && (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
              <AlertTriangle className="size-5 text-red-400" />
            </div>
          )}
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              {state.title}
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {state.message}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex justify-end gap-3">
          {state.mode !== 'info' && (
            <button
              onClick={() => close(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {state.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            data-confirm-btn
            onClick={() => close(true)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              isDanger
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'bg-zinc-600 text-white hover:bg-zinc-500'
            }`}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};
