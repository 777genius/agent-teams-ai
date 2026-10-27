import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { Root, RootContent } from 'mdast';

const markdownParser = unified().use(remarkParse);

/** Preserve original code bytes while applying legacy prose transformations. */
export function mapMarkdownOutsideCode(
  text: string,
  transform: (prose: string) => string,
  options: { handleInlineTaskReferences?: boolean } = {}
): string {
  if (!/[`~\t]| {4}/.test(text)) return transform(text);

  const ranges: { start: number; end: number }[] = [];
  function visit(node: Root | RootContent): void {
    if (node.type === 'code' || node.type === 'inlineCode') {
      // The task linkifier already handles inline code, task chips, and link labels.
      // Keep that input intact so structured task identities stay paired.
      if (node.type === 'inlineCode' && options.handleInlineTaskReferences) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else if ('children' in node) {
      for (const child of node.children) visit(child as RootContent);
    }
  }
  visit(markdownParser.parse(text));

  let result = '';
  let offset = 0;
  for (const { start, end } of ranges) {
    result += transform(text.slice(offset, start)) + text.slice(start, end);
    offset = end;
  }
  return result + transform(text.slice(offset));
}
