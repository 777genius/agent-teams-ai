export interface HastElementLike {
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export interface MarkdownFence {
  language: string | null;
  source: string;
  state: 'open' | 'closed';
}

function isHastElementLike(value: unknown): value is HastElementLike {
  return typeof value === 'object' && value !== null;
}

function getChildren(value: unknown): unknown[] {
  return isHastElementLike(value) && Array.isArray(value.children) ? value.children : [];
}

export function hastText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!isHastElementLike(value)) return '';
  if (typeof value.value === 'string') return value.value;
  return getChildren(value).map(hastText).join('');
}

function directCodeChild(node: unknown): HastElementLike | null {
  const child = getChildren(node)[0];
  return isHastElementLike(child) && child.tagName === 'code' ? child : null;
}

function readLanguage(code: HastElementLike): string | null {
  const classNames = code.properties?.className;
  const values = Array.isArray(classNames)
    ? classNames
    : typeof classNames === 'string'
      ? classNames.split(/\s+/)
      : [];
  const languageClass = values
    .map(String)
    .find((value) => value.startsWith('language-') && value.length > 'language-'.length);
  return languageClass ? languageClass.slice('language-'.length).toLowerCase() : null;
}

const FENCE_LINE = /^(?<delimiter>`{3,}|~{3,})[ \t]*(?<info>[^\r\n]*)$/;
const CLOSING_FENCE_SUFFIX = /(?<delimiter>`{3,}|~{3,})[ \t]*$/;
const lineBreakCount = (value: string): number => (value.match(/\r\n|\r|\n/g) ?? []).length;

function fenceStateFromMarkdown(
  source: string,
  startOffset: number,
  expectedLanguage: string | null,
  endOffset: number,
  codeSource: string
): 'open' | 'closed' | null {
  // The Markdown AST starts at the delimiter even inside deeply nested containers.
  const block = source.slice(startOffset, endOffset);
  const firstLineEnd = block.search(/[\r\n]/);
  const opener = FENCE_LINE.exec(block.slice(0, firstLineEnd === -1 ? block.length : firstLineEnd));
  if (!opener?.groups?.delimiter) return null;

  const delimiter = opener.groups.delimiter;
  const info = opener.groups.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (expectedLanguage && info && info !== expectedLanguage) return null;

  const finalLineStart = Math.max(block.lastIndexOf('\n'), block.lastIndexOf('\r')) + 1;
  const closing = CLOSING_FENCE_SUFFIX.exec(block.slice(finalLineStart));
  // A real closer is the AST's final source line and is absent from the emitted
  // HAST code text. An unclosed node retains fence-looking data such as "- ```".
  // HAST appends a newline to nonempty code, so closure leaves one extra source
  // line break (or more for an empty body), independent of container indentation.
  return closing?.groups?.delimiter &&
    closing.groups.delimiter.startsWith(delimiter[0]) &&
    closing.groups.delimiter.length >= delimiter.length &&
    lineBreakCount(block) > lineBreakCount(codeSource)
    ? 'closed'
    : 'open';
}

export function readMarkdownFence(originalMarkdown: string, node: unknown): MarkdownFence | null {
  const code = directCodeChild(node);
  if (!code) return null;

  const language = readLanguage(code);
  const source = hastText(code);
  const startOffset = isHastElementLike(node) ? node.position?.start?.offset : undefined;
  const endOffset = isHastElementLike(node) ? node.position?.end?.offset : undefined;
  const state =
    typeof startOffset === 'number' && typeof endOffset === 'number'
      ? fenceStateFromMarkdown(originalMarkdown, startOffset, language, endOffset, source)
      : null;

  return {
    language,
    source,
    state: state ?? 'closed',
  };
}
