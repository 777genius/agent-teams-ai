import { useEffect, useRef, useState } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useAppTranslation } from '@features/localization/renderer';
import { useOverlayOccupancy } from '@renderer/hooks/useOverlayOccupancy';
import { baseEditorTheme, jsonLinter } from '@renderer/utils/codemirrorTheme';
import { formatCustomThemesJson, parseCustomThemesJson } from '@renderer/utils/appearancePreferences';
import { X } from 'lucide-react';

import type { CustomTheme } from '@renderer/utils/appearancePreferences';

interface ThemeJsonEditorDialogProps {
  open: boolean;
  onClose: () => void;
  themes: readonly CustomTheme[];
  onSave: (themes: CustomTheme[]) => void;
}

/**
 * Same CodeMirror JSON editing primitives as the application config dialog,
 * but theme changes are explicitly applied (never auto-saved mid-JSON).
 */
export const ThemeJsonEditorDialog = ({
  open,
  onClose,
  themes,
  onSave,
}: ThemeJsonEditorDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useOverlayOccupancy(open);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: formatCustomThemesJson(themes),
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          json(),
          syntaxHighlighting(oneDarkHighlightStyle),
          jsonLinter,
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
          baseEditorTheme,
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setError(null);
          }),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [open, themes]);

  const apply = (): void => {
    if (!viewRef.current) return;
    try {
      const parsed = parseCustomThemesJson(viewRef.current.state.doc.toString());
      onSave(parsed);
      setError(null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-theme-json-title"
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-emphasis bg-surface shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id="appearance-theme-json-title" className="text-sm font-medium text-text">
            {t('general.appearance.customThemes.editor.title')}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-text-secondary hover:bg-surface-raised"
            onClick={onClose}
            aria-label={t('general.appearance.customThemes.editor.cancel')}
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="px-4 pt-3 text-xs text-text-muted">
          {t('general.appearance.customThemes.editor.description')}
        </p>
        <div ref={containerRef} data-testid="appearance-custom-theme-json" className="config-editor-container min-h-[240px] flex-1 overflow-hidden px-2 py-3" />
        {error && (
          <p role="alert" data-testid="appearance-theme-json-error" className="px-4 pb-2 text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border p-3">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised"
            onClick={onClose}
          >
            {t('general.appearance.customThemes.editor.cancel')}
          </button>
          <button
            type="button"
            data-testid="appearance-theme-json-save"
            className="rounded border border-border-emphasis bg-surface-raised px-3 py-1.5 text-xs font-medium text-text hover:opacity-80"
            onClick={apply}
          >
            {t('general.appearance.customThemes.editor.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
