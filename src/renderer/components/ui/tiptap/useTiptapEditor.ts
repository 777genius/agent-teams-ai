import { useEffect, useRef } from 'react';

import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { type Extension, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

interface UseTiptapEditorOptions {
  content: string;
  onChange?: (markdown: string) => void;
  editable?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  extensions?: Extension[];
}

export function useTiptapEditor({
  content,
  onChange,
  editable = true,
  autoFocus = false,
  placeholder = '',
  extensions: extraExtensions = [],
}: UseTiptapEditorOptions) {
  // Ref для стабильной ссылки — избегаем stale closure в onUpdate
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Double safety: ref guard для programmatic setContent (emitUpdate: false — основной механизм)
  const isProgrammaticUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({}),
      Markdown.configure({
        markedOptions: { gfm: true },
      }),
      Placeholder.configure({
        placeholder,
        showOnlyWhenEditable: true,
      }),
      ...extraExtensions,
    ],
    content,
    contentType: 'markdown',
    editable,
    shouldRerenderOnTransaction: false, // v3 performance — toolbar использует useEditorState
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor: e }) => {
      if (isProgrammaticUpdate.current) return;
      try {
        const md = e.getMarkdown();
        onChangeRef.current?.(md);
      } catch {
        console.error('[TiptapEditor] getMarkdown() failed, skipping onChange');
      }
    },
  });

  // === Content sync ===
  // Когда внешний content меняется, обновляем editor БЕЗ триггера onUpdate
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    let currentMd: string;
    try {
      currentMd = editor.getMarkdown();
    } catch {
      return;
    }

    if (currentMd.trim() === content.trim()) return;

    isProgrammaticUpdate.current = true;
    try {
      editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
    } catch {
      console.error('[TiptapEditor] setContent() failed');
    } finally {
      isProgrammaticUpdate.current = false;
    }
  }, [content, editor]);

  // === Editable toggle ===
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  return { editor };
}
