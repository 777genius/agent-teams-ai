import type { TiptapEditorProps } from './types';

export const EDITOR_PRESETS = {
  full: {
    toolbar: true,
    bubbleMenu: true,
    minHeight: '120px',
    maxHeight: '400px',
  },
  compact: {
    toolbar: {
      bold: true,
      italic: true,
      strike: true,
      code: true,
      bulletList: true,
      orderedList: true,
      undoRedo: true,
      codeBlock: false,
      heading: false,
      blockquote: false,
      horizontalRule: false,
    },
    bubbleMenu: true,
    minHeight: '60px',
    maxHeight: '200px',
  },
  minimal: {
    toolbar: {
      bold: true,
      italic: true,
      code: true,
      strike: false,
      codeBlock: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      blockquote: false,
      horizontalRule: false,
      undoRedo: false,
    },
    bubbleMenu: false,
    minHeight: '40px',
    maxHeight: '120px',
  },
} as const satisfies Record<string, Partial<TiptapEditorProps>>;
