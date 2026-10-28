import { readMarkdownFence } from '@renderer/components/chat/viewers/MarkdownFence';
import { toHast } from 'mdast-util-to-hast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

import type { MarkdownFence } from '@renderer/components/chat/viewers/MarkdownFence';
import type { Root, RootContent } from 'mdast';

const markdownParser = unified().use(remarkParse);
function readFences(markdown: string): MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  function visit(node: Root | RootContent): void {
    if (node.type === 'code') {
      const fence = readMarkdownFence(markdown, toHast(node));
      if (fence) fences.push(fence);
    } else if ('children' in node) {
      for (const child of node.children) visit(child as RootContent);
    }
  }
  visit(markdownParser.parse(markdown));
  return fences;
}
describe('Markdown fence dispatch', () => {
  it.each([
    '```openui-lang\nroot = Stack([]);\n```\n',
    '~~~openui-lang\r\nroot = Stack([]);\r\n~~~\r\n',
    '~~~openui-lang\rroot = Stack([]);\r~~~',
    '> ```openui-lang\n> root = Stack([]);\n> ```\n',
    '- ```openui-lang\n  root = Stack([]);\n  ```\n',
    '   ```openui-lang\nroot = Stack([]);\n  ```',
    '> - ```openui-lang\n>   root = Stack([]);\n>   ```',
    '```openui-lang\nroot = Stack([]);\n`````',
    '- a\n  - b\n    - c\n      - d\n\n        ```openui-lang\n        root = Stack([]);\n        ```',
  ])('recognizes a closed fence in Markdown containers', (markdown) => {
    expect(readFences(markdown)[0]).toEqual({
      language: 'openui-lang',
      source: 'root = Stack([]);\n',
      state: 'closed',
    });
  });
  it('does not borrow a later closing fence after an unclosed blockquote', () => {
    const quote = '> ```openui-lang\n> root = Stack([]);';
    const markdown = quote + '\n\nOutside\n```ts\nconst x = 1;\n```';
    expect(readFences(markdown)[0]?.state).toBe('open');
  });
  it('does not treat a shorter closing delimiter as complete', () => {
    expect(readFences('````openui\nroot = Stack([]);\n```')[0]?.state).toBe('open');
  });
  it('reads the matching code block rather than another block in the message', () => {
    const before = '```ts\nconst x = 1;\n```\n\n';
    expect(readFences(before + '```mermaid\ngraph TD;')[1]?.state).toBe('open');
  });

  it.each(['- ```', '> ```', '1. ```', '    ```'])(
    'does not treat literal code data %s as a closing fence',
    (lastLine) => {
      for (const ending of ['', '\n', '\n\n']) {
        const markdown = `\`\`\`openui\nroot = Stack([Card([TextContent("hello\n${lastLine}${ending}`;
        expect(readFences(markdown)[0]?.state).toBe('open');
      }
    }
  );

  it('keeps a deeply nested unclosed list fence open', () => {
    const markdown =
      '- a\n  - b\n    - c\n      - d\n\n        ```openui\n        root = Stack([]);';
    expect(readFences(markdown)[0]?.state).toBe('open');
  });

  it.each(['```openui\n```', '```openui\n\n```', '> ~~~openui\n> ~~~'])(
    'recognizes an empty closed fence: %s',
    (markdown) => expect(readFences(markdown)[0]?.state).toBe('closed')
  );

  it('closes only at the actual final delimiter after fence-looking code data', () => {
    const markdown = '```openui\nroot = Stack([Card([TextContent("hello\n- ```\nrest")])]);\n```';
    expect(readFences(markdown)[0]?.state).toBe('closed');
  });
});
