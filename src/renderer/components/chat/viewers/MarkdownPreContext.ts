import React from 'react';

export interface MarkdownPreContextValue {
  originalMarkdown: string;
  copyCodeBlocks: boolean;
  compactPreview: boolean;
}

const DEFAULT_MARKDOWN_PRE_CONTEXT: MarkdownPreContextValue = {
  originalMarkdown: '',
  copyCodeBlocks: false,
  compactPreview: false,
};

export const MarkdownPreContext = React.createContext<MarkdownPreContextValue>(
  DEFAULT_MARKDOWN_PRE_CONTEXT
);
