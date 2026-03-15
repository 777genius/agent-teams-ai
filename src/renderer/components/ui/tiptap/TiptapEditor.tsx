import { EditorContent, EditorContext } from '@tiptap/react';
import { useMemo } from 'react';

import { cn } from '@renderer/lib/utils';

import { TiptapBubbleMenu } from './TiptapBubbleMenu';
import { TiptapToolbar } from './TiptapToolbar';
import type { TiptapEditorProps } from './types';
import { useTiptapEditor } from './useTiptapEditor';

import './tiptapStyles.css';

export function TiptapEditor({
  content,
  onChange,
  placeholder,
  editable = true,
  minHeight,
  maxHeight,
  autoFocus = false,
  toolbar = true,
  bubbleMenu = true,
  extensions,
  className,
  disabled = false,
}: TiptapEditorProps) {
  const isEditable = editable && !disabled;
  const { editor } = useTiptapEditor({
    content,
    onChange,
    editable: isEditable,
    autoFocus,
    placeholder,
    extensions,
  });

  // EditorContext.Provider — v3 паттерн для sharing editor instance
  // TiptapToolbar и TiptapBubbleMenu получают editor через useCurrentEditor()
  const providerValue = useMemo(() => ({ editor }), [editor]);

  if (!editor) return null;

  const showToolbar = toolbar !== false && isEditable;
  const showBubble = bubbleMenu && isEditable;
  const toolbarConfig = typeof toolbar === 'object' ? toolbar : undefined;

  return (
    <EditorContext.Provider value={providerValue}>
      <div
        className={cn(
          'tiptap-editor-wrapper rounded-md border border-[var(--color-border)] bg-transparent',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
      >
        {showToolbar && <TiptapToolbar config={toolbarConfig} />}

        <div
          className="overflow-y-auto px-3 py-2"
          style={{
            minHeight: minHeight ?? '60px',
            maxHeight: maxHeight ?? 'none',
          }}
        >
          <EditorContent editor={editor} />
        </div>

        {showBubble && <TiptapBubbleMenu />}
      </div>
    </EditorContext.Provider>
  );
}
