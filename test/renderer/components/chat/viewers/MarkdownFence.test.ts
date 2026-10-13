import { readMarkdownFence } from '@renderer/components/chat/viewers/MarkdownFence';
import { describe, expect, it } from 'vitest';

function node(offset: number, language: string, endOffset: number) {
  return {
    position: { start: { offset }, end: { offset: endOffset } },
    children: [
      {
        tagName: 'code',
        properties: { className: [`language-${language}`] },
        children: [{ value: 'root = Stack([]);\n' }],
      },
    ],
  };
}
describe('Markdown fence dispatch', () => {
  it.each([
    '```openui-lang\nroot = Stack([]);\n```\n',
    '~~~openui-lang\r\nroot = Stack([]);\r\n~~~\r\n',
    '> ```openui-lang\n> root = Stack([]);\n> ```\n',
    '- ```openui-lang\n  root = Stack([]);\n  ```\n',
  ])('recognizes a closed fence in Markdown containers', (markdown) => {
    expect(readMarkdownFence(markdown, node(0, 'openui-lang', markdown.length))).toEqual({
      language: 'openui-lang',
      source: 'root = Stack([]);\n',
      state: 'closed',
    });
  });
  it('does not borrow a later closing fence after an unclosed blockquote', () => {
    const quote = '> ```openui-lang\n> root = Stack([]);';
    const markdown = quote + '\n\nOutside\n```ts\nconst x = 1;\n```';
    expect(readMarkdownFence(markdown, node(0, 'openui-lang', quote.length))?.state).toBe('open');
  });
  it('does not treat a shorter closing delimiter as complete', () => {
    expect(
      readMarkdownFence('````openui\nroot = Stack([]);\n```', node(0, 'openui', 42))?.state
    ).toBe('open');
  });
  it('reads the matching code block rather than another block in the message', () => {
    const before = '```ts\nconst x = 1;\n```\n\n';
    expect(
      readMarkdownFence(
        before + '```mermaid\ngraph TD;',
        node(before.length, 'mermaid', before.length + 23)
      )?.state
    ).toBe('open');
  });
});
