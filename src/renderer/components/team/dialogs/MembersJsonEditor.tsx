import React, { useEffect, useRef } from 'react';

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { Button } from '@renderer/components/ui/button';
import { baseEditorTheme, jsonLinter } from '@renderer/utils/codemirrorTheme';
import { X } from 'lucide-react';

interface MembersJsonEditorProps {
  value: string;
  onChange: (json: string) => void;
  error: string | null;
  onClose: () => void;
}

const membersEditorTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    maxHeight: '300px',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
});

export const MembersJsonEditor = ({
  value,
  onChange,
  error,
  onClose,
}: MembersJsonEditorProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        json(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(oneDarkHighlightStyle),
        jsonLinter,
        lintGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
        baseEditorTheme,
        membersEditorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- EditorView created once on mount
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div className="space-y-1">
      <div className="overflow-hidden rounded border border-[var(--color-border)]">
        <div className="flex items-center justify-end border-b border-[var(--color-border)] px-2 py-1.5">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onClose}>
            <X className="size-3.5" />
            Hide JSON
          </Button>
        </div>
        <div ref={containerRef} />
      </div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
};
