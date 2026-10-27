import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  readMarkdownFence,
  type MarkdownFence,
} from '../../src/renderer/components/chat/viewers/MarkdownFence';
import { stripAgentBlocks } from '../../src/shared/constants/agentBlocks';

import type { Root, RootContent } from 'mdast';

const markdownParser = unified().use(remarkParse);

/** Read the same visible code nodes the chat renders, preserving their display order. */
export function readOpenUIReply(text: string): { fences: MarkdownFence[]; prose: string } {
  const markdown = stripAgentBlocks(text);
  const fences: MarkdownFence[] = [];
  const prose: string[] = [];
  function visit(node: Root | RootContent): void {
    if (node.type === 'code') {
      const fence = readMarkdownFence(markdown, {
        tagName: 'pre',
        position: node.position,
        children: [
          {
            tagName: 'code',
            properties: { className: [`language-${node.lang ?? ''}`] },
            children: [{ value: node.value }],
          },
        ],
      });
      if (fence && ['openui', 'openui-lang'].includes(fence.language ?? '')) fences.push(fence);
    } else if (node.type === 'text' || node.type === 'inlineCode') prose.push(node.value);
    else if ('children' in node) for (const child of node.children) visit(child as RootContent);
  }
  visit(markdownParser.parse(markdown));
  return { fences, prose: prose.join(' ') };
}
