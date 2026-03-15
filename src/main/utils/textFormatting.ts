import remarkParse from 'remark-parse';
import stripMarkdownPlugin from 'strip-markdown';
import { unified } from 'unified';

/**
 * Minimal plain-text compiler for unified.
 * After strip-markdown, the MDAST contains only text nodes —
 * this compiler simply concatenates their values.
 *
 * Replaces remark-stringify to avoid ESM→CJS interop issues
 * in Electron's main process (CJS output format).
 */
function plainTextCompiler(this: ReturnType<typeof unified>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (this as any).compiler = (tree: any): string => {
    const parts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function visit(node: any): void {
      if ('value' in node && typeof node.value === 'string') {
        parts.push(node.value);
      }
      if ('children' in node && Array.isArray(node.children)) {
        node.children.forEach(visit);
      }
    }
    visit(tree);
    return parts.join('');
  };
}

const processor = unified().use(remarkParse).use(stripMarkdownPlugin).use(plainTextCompiler);

/**
 * Strips markdown formatting from text for use in plain-text contexts
 * like native OS notifications.
 *
 * Uses remark ecosystem (strip-markdown plugin) for reliable parsing.
 * Pipeline: remarkParse → stripMarkdown (transform) → plainTextCompiler (extract text).
 */
export function stripMarkdown(text: string): string {
  const result = processor.processSync(text);
  return String(result).trim();
}
