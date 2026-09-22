import { useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
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
import { getSyncLanguageExtension } from '@renderer/utils/codemirrorLanguages';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';

const skillEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
  },
});

interface SkillCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  scrollRef?: React.RefObject<HTMLElement | null>;
  onScroll?: () => void;
}

export const SkillCodeEditor = ({
  value,
  onChange,
  scrollRef,
  onScroll,
}: SkillCodeEditorProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        getSyncLanguageExtension('SKILL.md') ?? [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        search(),
        syntaxHighlighting(oneDarkHighlightStyle),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
        baseEditorTheme,
        skillEditorTheme,
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
    if (onScroll) {
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    }
    if (scrollRef && 'current' in scrollRef) {
      const mutableRef = scrollRef as React.MutableRefObject<HTMLElement | null>;
      mutableRef.current = view.scrollDOM;
    }

    return () => {
      if (onScroll) {
        view.scrollDOM.removeEventListener('scroll', onScroll);
      }
      if (scrollRef && 'current' in scrollRef) {
        const mutableRef = scrollRef as React.MutableRefObject<HTMLElement | null>;
        mutableRef.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create editor once per mount
  }, [onScroll, scrollRef]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc === value) return;

    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: value },
    });
  }, [value]);

  return <div ref={containerRef} className="h-full min-h-0" />;
};
