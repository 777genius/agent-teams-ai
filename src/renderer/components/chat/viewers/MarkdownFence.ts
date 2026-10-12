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

const CONTAINER_MARKER = /^(?:>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+)/;
const FENCE_LINE = /^(?<delimiter>`{3,}|~{3,})[ \t]*(?<info>[^\r\n]*)$/;
const CLOSING_FENCE_LINE = /^(?<delimiter>`{3,}|~{3,})[ \t]*$/;

function stripContainerPrefix(line: string): string {
  let body = line.replace(/^[ \t]{0,3}/, '');
  let marker = CONTAINER_MARKER.exec(body);
  while (marker) {
    body = body.slice(marker[0].length);
    marker = CONTAINER_MARKER.exec(body);
  }
  return body.replace(/^[ \t]{0,3}/, '');
}

function findLineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function fenceStateFromMarkdown(
  source: string,
  startOffset: number,
  expectedLanguage: string | null,
  endOffset: number
): 'open' | 'closed' | null {
  source = source.slice(0, endOffset);
  const lineStart = findLineStart(source, startOffset);
  const firstLineEnd = source.indexOf('\n', lineStart);
  const openerEnd = firstLineEnd === -1 ? source.length : firstLineEnd;
  const opener = FENCE_LINE.exec(
    stripContainerPrefix(source.slice(lineStart, openerEnd).replace(/\r$/, ''))
  );
  if (!opener?.groups?.delimiter) return null;

  const delimiter = opener.groups.delimiter;
  const info = opener.groups.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (expectedLanguage && info && info !== expectedLanguage) return null;

  let lineStartOffset = openerEnd;
  while (lineStartOffset < source.length) {
    const nextLineStart = source.startsWith('\n', lineStartOffset)
      ? lineStartOffset + 1
      : lineStartOffset;
    const nextLineEnd = source.indexOf('\n', nextLineStart);
    const lineEnd = nextLineEnd === -1 ? source.length : nextLineEnd;
    const closing = CLOSING_FENCE_LINE.exec(
      stripContainerPrefix(source.slice(nextLineStart, lineEnd).replace(/\r$/, ''))
    );
    if (
      closing?.groups?.delimiter &&
      closing.groups.delimiter.startsWith(delimiter[0]) &&
      closing.groups.delimiter.length >= delimiter.length
    ) {
      return 'closed';
    }
    if (nextLineEnd === -1) break;
    lineStartOffset = nextLineEnd;
  }
  return 'open';
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
      ? fenceStateFromMarkdown(originalMarkdown, startOffset, language, endOffset)
      : null;

  return {
    language,
    source,
    state: state ?? 'closed',
  };
}
