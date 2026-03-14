import { useCurrentEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Code, Italic, Strikethrough } from 'lucide-react';

import { cn } from '@renderer/lib/utils';

export function TiptapBubbleMenu() {
  const { editor } = useCurrentEditor();

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      return {
        isBold: e.isActive('bold'),
        isItalic: e.isActive('italic'),
        isStrike: e.isActive('strike'),
        isCode: e.isActive('code'),
      };
    },
  });

  if (!editor || !state) return null;

  const btnClass = (active: boolean) =>
    cn(
      'rounded p-1 transition-colors text-[var(--color-text-muted)]',
      'hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]',
      active && 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
    );

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top', offset: 8 }}
      className={cn(
        'flex items-center gap-0.5 rounded-lg p-1 shadow-lg',
        'border border-[var(--color-border-emphasis)]',
        'bg-[var(--color-surface-overlay)]'
      )}
    >
      <button
        type="button"
        className={btnClass(state.isBold)}
        onClick={() => editor.chain().focus().toggleBold().run()}
        aria-label="Bold"
      >
        <Bold size={12} />
      </button>
      <button
        type="button"
        className={btnClass(state.isItalic)}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        aria-label="Italic"
      >
        <Italic size={12} />
      </button>
      <button
        type="button"
        className={btnClass(state.isStrike)}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        aria-label="Strike"
      >
        <Strikethrough size={12} />
      </button>
      <button
        type="button"
        className={btnClass(state.isCode)}
        onClick={() => editor.chain().focus().toggleCode().run()}
        aria-label="Code"
      >
        <Code size={12} />
      </button>
    </BubbleMenu>
  );
}
