/**
 * Inline input for creating a new file or directory in the file tree.
 *
 * Auto-focuses, validates on the client side, submits on Enter, cancels on Escape.
 * Uses click-outside detection instead of onBlur for dismissal — onBlur is
 * unreliable when the input lives inside a virtualizer + DnD context + Radix
 * context menu (all of which can steal focus transiently).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isImeComposing } from '@renderer/utils/imeComposition';
import { FilePlus, FolderPlus } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface NewFileDialogProps {
  type: 'file' | 'directory';
  parentDir: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

// =============================================================================
// Validation
// =============================================================================

// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- Intentional: validating filenames against control characters
const INVALID_CHARS = /[\x00-\x1f/\\:*?"<>|]/;

function validateName(name: string, t: ReturnType<typeof useAppTranslation>['t']): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return t('editor.newFile.validation.nameRequired');
  if (trimmed === '.' || trimmed === '..') return t('editor.newFile.validation.invalidName');
  if (INVALID_CHARS.test(trimmed)) return t('editor.newFile.validation.invalidCharacters');
  if (trimmed.length > 255) return t('editor.newFile.validation.nameTooLong');
  return null;
}

// =============================================================================
// Component
// =============================================================================

export const NewFileDialog = ({
  type,
  parentDir: _parentDir,
  onSubmit,
  onCancel,
}: NewFileDialogProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus input after Radix context menu finishes its focus restoration
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Click-outside → cancel (replaces unreliable onBlur)
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    // Delay listener registration so the context menu close click isn't caught
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 150);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onCancel]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    const validationError = validateName(trimmed, t);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(trimmed);
  }, [value, onSubmit, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isImeComposing(e) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      e.stopPropagation();
    },
    [handleSubmit, onCancel]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setError(null);
  }, []);

  const Icon = type === 'file' ? FilePlus : FolderPlus;

  return (
    <div ref={containerRef} className="flex flex-col px-2 py-1">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => requestAnimationFrame(() => inputRef.current?.focus())}
          placeholder={
            type === 'file'
              ? t('editor.newFile.placeholders.fileName')
              : t('editor.newFile.placeholders.folderName')
          }
          className="min-w-0 flex-1 rounded border border-border-emphasis bg-surface px-1.5 py-0.5 text-xs text-text outline-none focus:border-blue-500"
          aria-label={
            type === 'file'
              ? t('editor.newFile.aria.newFileName')
              : t('editor.newFile.aria.newFolderName')
          }
        />
      </div>
      {error && <span className="mt-0.5 pl-5 text-[10px] text-red-400">{error}</span>}
    </div>
  );
};
