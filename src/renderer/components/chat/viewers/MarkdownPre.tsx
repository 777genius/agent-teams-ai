import React from 'react';

import {
  ChatVisualizationProvider,
  VisualizationBlock,
} from '@features/chat-visualizations/renderer';
import { extractTextFromReactNode } from '@renderer/components/chat/markdownCopyUtils';
import { CopyButton } from '@renderer/components/common/CopyButton';
import {
  PROSE_CODE_BG,
  PROSE_CODE_TEXT,
  PROSE_PRE_BG,
  PROSE_PRE_BORDER,
} from '@renderer/constants/cssVariables';

import { type HastElementLike, readMarkdownFence } from './MarkdownFence';
import { MarkdownPreContext } from './MarkdownPreContext';
import { MermaidDiagram } from './MermaidDiagram';

const MermaidVisualization = ({ source }: { source: string }): React.JSX.Element => {
  return <MermaidDiagram code={source} />;
};

export const MarkdownPre = ({
  children,
  node,
}: React.PropsWithChildren<{ node?: HastElementLike }>): React.JSX.Element => {
  const { originalMarkdown, copyCodeBlocks, compactPreview } = React.useContext(MarkdownPreContext);
  const fence = readMarkdownFence(originalMarkdown, node);

  if (compactPreview) {
    const compactText =
      fence?.language === 'mermaid'
        ? 'Diagram'
        : fence?.language === 'openui' || fence?.language === 'openui-lang'
          ? 'Visualization'
          : extractTextFromReactNode(children).trim();
    return (
      <code
        className="break-all rounded px-1.5 py-0.5 font-mono text-xs"
        style={{ backgroundColor: PROSE_CODE_BG, color: PROSE_CODE_TEXT }}
      >
        {compactText}
      </code>
    );
  }

  const kind =
    fence?.language === 'mermaid'
      ? 'mermaid'
      : fence?.language === 'openui-lang' || fence?.language === 'openui'
        ? 'openui'
        : null;
  if (fence && kind) {
    return (
      <ChatVisualizationProvider MermaidVisualization={MermaidVisualization}>
        <VisualizationBlock kind={kind} source={fence.source} fenceState={fence.state} />
      </ChatVisualizationProvider>
    );
  }

  const codeText = copyCodeBlocks ? extractTextFromReactNode(children).trim() : '';
  return (
    <pre
      className={`my-3 max-w-full overflow-x-auto rounded-lg p-3 text-xs leading-relaxed ${codeText ? 'group relative' : ''}`.trim()}
      style={{ backgroundColor: PROSE_PRE_BG, border: `1px solid ${PROSE_PRE_BORDER}` }}
    >
      {codeText ? <CopyButton text={codeText} /> : null}
      {children}
    </pre>
  );
};
