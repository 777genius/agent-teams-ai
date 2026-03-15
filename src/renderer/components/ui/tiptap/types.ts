import type { Extension } from '@tiptap/react';

export interface ToolbarConfig {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  codeBlock?: boolean;
  heading?: false | { levels: (1 | 2 | 3)[] };
  bulletList?: boolean;
  orderedList?: boolean;
  blockquote?: boolean;
  horizontalRule?: boolean;
  undoRedo?: boolean;
}

export interface TiptapEditorProps {
  content: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  editable?: boolean;
  minHeight?: string;
  maxHeight?: string;
  autoFocus?: boolean;
  toolbar?: boolean | ToolbarConfig;
  bubbleMenu?: boolean;
  extensions?: Extension[];
  className?: string;
  disabled?: boolean;
}

export type EditorPreset = 'full' | 'compact' | 'minimal';
