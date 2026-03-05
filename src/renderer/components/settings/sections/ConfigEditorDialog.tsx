/**
 * ConfigEditorDialog — inline JSON config editor powered by CodeMirror.
 *
 * Opens as a dialog, shows the full app config as formatted JSON.
 * Auto-saves on changes with debounce. Shows validation errors for malformed JSON.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

import type { AppConfig } from '@renderer/types/data';

// =============================================================================
// Constants
// =============================================================================

const SAVE_DEBOUNCE_MS = 800;

// =============================================================================
// JSON Linter
// =============================================================================

const jsonLinter = linter((view: EditorView) => {
  const diagnostics: Diagnostic[] = [];
  const text = view.state.doc.toString();
  try {
    JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) {
      const match = /position (\d+)/.exec(e.message);
      const pos = match ? parseInt(match[1], 10) : 0;
      const safePos = Math.min(pos, text.length);
      diagnostics.push({
        from: safePos,
        to: Math.min(safePos + 1, text.length),
        severity: 'error',
        message: e.message,
      });
    }
  }
  return diagnostics;
});

// =============================================================================
// Types
// =============================================================================

interface ConfigEditorDialogProps {
  open: boolean;
  onClose: () => void;
  onConfigSaved: (config: AppConfig) => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// =============================================================================
// Component
// =============================================================================

export const ConfigEditorDialog = ({
  open,
  onClose,
  onConfigSaved,
}: ConfigEditorDialogProps): React.JSX.Element | null => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const savedRevertTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const initialConfigRef = useRef<string>('');

  const saveConfig = useCallback(
    async (jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as AppConfig;
        setJsonError(null);
        setSaveStatus('saving');

        // Save each section separately via existing API
        if (parsed.general) {
          await api.config.update('general', parsed.general);
        }
        if (parsed.notifications) {
          await api.config.update('notifications', parsed.notifications);
        }
        if (parsed.display) {
          await api.config.update('display', parsed.display);
        }
        if (parsed.sessions) {
          await api.config.update('sessions', parsed.sessions);
        }

        // Re-fetch to get the canonical saved state
        const fresh = await api.config.get();
        onConfigSaved(fresh);
        useStore.setState({ appConfig: fresh });
        initialConfigRef.current = JSON.stringify(fresh, null, 2);

        setSaveStatus('saved');
        if (savedRevertTimerRef.current) clearTimeout(savedRevertTimerRef.current);
        savedRevertTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (e) {
        if (e instanceof SyntaxError) {
          setJsonError(e.message);
          setSaveStatus('idle');
        } else {
          setSaveStatus('error');
          setJsonError(e instanceof Error ? e.message : 'Failed to save config');
          if (savedRevertTimerRef.current) clearTimeout(savedRevertTimerRef.current);
          savedRevertTimerRef.current = setTimeout(() => {
            setSaveStatus('idle');
            setJsonError(null);
          }, 4000);
        }
      }
    },
    [onConfigSaved]
  );

  const scheduleSave = useCallback(
    (jsonText: string) => {
      // Validate JSON before scheduling save
      try {
        JSON.parse(jsonText);
        setJsonError(null);
      } catch (e) {
        if (e instanceof SyntaxError) {
          setJsonError(e.message);
        }
        return;
      }

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void saveConfig(jsonText);
      }, SAVE_DEBOUNCE_MS);
    },
    [saveConfig]
  );

  // Initialize CodeMirror when dialog opens
  useEffect(() => {
    if (!open) return;

    let destroyed = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
    setLoading(true);
    setSaveStatus('idle');
    setJsonError(null);

    const init = async (): Promise<void> => {
      try {
        const config = await api.config.get();
        if (destroyed) return;

        const jsonText = JSON.stringify(config, null, 2);
        initialConfigRef.current = jsonText;
        setLoading(false);

        // Wait for DOM render
        requestAnimationFrame(() => {
          if (destroyed || !editorRef.current) return;

          // Clean up existing view
          if (viewRef.current) {
            viewRef.current.destroy();
            viewRef.current = null;
          }

          const state = EditorState.create({
            doc: jsonText,
            extensions: [
              lineNumbers(),
              highlightActiveLineGutter(),
              highlightActiveLine(),
              history(),
              foldGutter(),
              indentOnInput(),
              bracketMatching(),
              json(),
              syntaxHighlighting(oneDarkHighlightStyle),
              jsonLinter,
              lintGutter(),
              search(),
              keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
              baseEditorTheme,
              configEditorTheme,
              // eslint-disable-next-line sonarjs/no-nested-functions -- CodeMirror listener callback within useEffect setup
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  const text = update.state.doc.toString();
                  scheduleSave(text);
                }
              }),
            ],
          });

          const view = new EditorView({
            state,
            parent: editorRef.current,
          });
          viewRef.current = view;
        });
      } catch (e) {
        if (destroyed) return;
        setLoading(false);
        setJsonError(e instanceof Error ? e.message : 'Failed to load config');
      }
    };

    void init();

    return () => {
      destroyed = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedRevertTimerRef.current) clearTimeout(savedRevertTimerRef.current);
    };
  }, [open, scheduleSave]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{
          backgroundColor: 'var(--color-surface)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              Edit Configuration
            </h2>
            <SaveStatusBadge status={saveStatus} error={jsonError} />
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Editor */}
        <div className="relative min-h-0 flex-1">
          {loading ? (
            <div
              className="flex h-96 items-center justify-center gap-2 text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Loader2 className="size-4 animate-spin" />
              Loading config...
            </div>
          ) : (
            <div ref={editorRef} className="config-editor-container h-full min-h-[400px]" />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between border-t px-4 py-2.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Changes auto-save after editing
          </p>
          <div className="flex items-center gap-2">
            <kbd
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              Esc
            </kbd>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              to close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// Save Status Badge
// =============================================================================

const SaveStatusBadge = ({
  status,
  error,
}: {
  status: SaveStatus;
  error: string | null;
}): React.JSX.Element | null => {
  if (status === 'idle' && !error) return null;

  if (error && status !== 'saving') {
    return (
      <span
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
        style={{ backgroundColor: 'rgba(248, 113, 113, 0.15)', color: '#f87171' }}
        title={error}
      >
        <AlertTriangle className="size-3" />
        {status === 'error' ? 'Save failed' : 'Invalid JSON'}
      </span>
    );
  }

  if (status === 'saving') {
    return (
      <span
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
        style={{ backgroundColor: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' }}
      >
        <Loader2 className="size-3 animate-spin" />
        Saving...
      </span>
    );
  }

  if (status === 'saved') {
    return (
      <span
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
        style={{ backgroundColor: 'rgba(74, 222, 128, 0.15)', color: '#4ade80' }}
      >
        <Check className="size-3" />
        Saved
      </span>
    );
  }

  return null;
};

// =============================================================================
// Editor Theme Override
// =============================================================================

const configEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    maxHeight: 'calc(85vh - 100px)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    padding: '8px 0',
  },
  '.cm-content': {
    padding: '0 8px',
  },
  '.cm-gutters': {
    paddingLeft: '4px',
  },
});
