import { useEffect, useRef, useState } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useAppTranslation } from '@features/localization/renderer';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { formatCustomThemesJson, parseCustomThemesJson } from '@renderer/utils/appearancePreferences';
import { baseEditorTheme, jsonLinter } from '@renderer/utils/codemirrorTheme';

import type { CustomTheme } from '@renderer/utils/appearancePreferences';
import type { RefObject } from 'react';

interface ThemeJsonEditorDialogProps {
  open: boolean;
  onClose: () => void;
  themes: readonly CustomTheme[];
  focusReturnRef: RefObject<HTMLButtonElement | null>;
  onSave: (themes: CustomTheme[], forceOverwrite: boolean) => void;
}

/**
 * Same CodeMirror JSON editing primitives as the application config dialog,
 * but theme changes are explicitly applied (never auto-saved mid-JSON).
 */
export const ThemeJsonEditorDialog = ({
  open,
  onClose,
  themes,
  focusReturnRef,
  onSave,
}: ThemeJsonEditorDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!open || !container) return;
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
            if (update.docChanged) {
              setError(null);
              setConflict(false);
            }
          }),
        ],
      }),
      parent: container,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [open, themes, container]);

  const apply = (forceOverwrite = false): void => {
    if (!viewRef.current) return;
    try {
      const parsed = parseCustomThemesJson(viewRef.current.state.doc.toString());
      onSave(parsed, forceOverwrite);
      setError(null);
      setConflict(false);
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === t('general.appearance.customThemes.editor.conflict')) {
        setError(message);
        setConflict(true);
      } else {
        setConflict(false);
        const label = cause instanceof SyntaxError
          ? t('general.appearance.customThemes.editor.invalidJson')
          : t('general.appearance.customThemes.editor.invalidTheme');
        setError(`${label}: ${message}`);
      }
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        data-testid="appearance-theme-editor-dialog"
        className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusReturnRef.current?.focus();
        }}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">
            {t('general.appearance.customThemes.editor.title')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('general.appearance.customThemes.editor.description')}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={setContainer}
          data-testid="appearance-custom-theme-json"
          className="config-editor-container min-h-[240px] flex-1 overflow-hidden px-2 py-3"
        />
        {error && (
          <p role="alert" data-testid="appearance-theme-json-error" className="px-4 pb-2 text-xs text-red-400">
            {error}
          </p>
        )}
        <DialogFooter className="flex-row justify-end gap-2 border-t border-border p-3">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised"
            onClick={onClose}
          >
            {t('general.appearance.customThemes.editor.cancel')}
          </button>
          {conflict && (
            <button
              type="button"
              data-testid="appearance-theme-json-overwrite"
              className="rounded border border-amber-500/40 px-3 py-1.5 text-xs text-text"
              onClick={() => apply(true)}
            >
              {t('general.appearance.customThemes.editor.overwrite')}
            </button>
          )}
          <button
            type="button"
            data-testid="appearance-theme-json-save"
            className="rounded border border-border-emphasis bg-surface-raised px-3 py-1.5 text-xs font-medium text-text hover:opacity-80"
            onClick={() => apply()}
          >
            {t('general.appearance.customThemes.editor.save')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
