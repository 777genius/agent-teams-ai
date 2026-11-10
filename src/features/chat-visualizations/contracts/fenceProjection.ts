import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { Root, RootContent } from 'mdast';

const markdownParser = unified().use(remarkParse);

function projectFences(source: string): string {
  if (!/(?:`{3,}|~{3,})[ \t]*(?:openui(?:-lang)?|mermaid)(?:\s|$)/i.test(source)) return source;
  const replacements: { start: number; end: number; label: string }[] = [];
  function visit(node: Root | RootContent): void {
    if (node.type === 'code') {
      const language = node.lang?.toLowerCase();
      const label =
        language === 'mermaid'
          ? 'Diagram'
          : language === 'openui' || language === 'openui-lang'
            ? 'Visualization'
            : null;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (label && start !== undefined && end !== undefined)
        replacements.push({ start, end, label });
    } else if ('children' in node) {
      for (const child of node.children) visit(child as RootContent);
    }
  }
  visit(markdownParser.parse(source));
  let result = '';
  let offset = 0;
  for (const { start, end, label } of replacements) {
    result += source.slice(offset, start) + label;
    offset = end;
  }
  return result + source.slice(offset);
}

export const summarizeVisualizationFences = projectFences;
export const omitVisualizationSourceForSearch = projectFences;
