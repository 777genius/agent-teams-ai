import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { MAX_MARKDOWN_CHARS } from './markdownLimits';

import type { Root, RootContent } from 'mdast';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

interface CodeRange {
  start: number;
  end: number;
  type: 'code' | 'inlineCode';
}

function getCodeRanges(root: Root, skipInline = false): CodeRange[] {
  const ranges: CodeRange[] = [];
  function visit(node: Root | RootContent): void {
    if (node.type === 'code' || node.type === 'inlineCode') {
      if (node.type === 'inlineCode' && skipInline) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end, type: node.type });
    } else if ('children' in node) {
      for (const child of node.children) visit(child as RootContent);
    }
  }
  visit(root);
  return ranges;
}

function mapOutsideRanges(
  text: string,
  ranges: readonly Pick<CodeRange, 'start' | 'end'>[],
  transform: (prose: string, sourceOffset: number) => string
): string {
  let result = '';
  let offset = 0;
  for (const { start, end } of ranges) {
    result += transform(text.slice(offset, start), offset) + text.slice(start, end);
    offset = end;
  }
  return result + transform(text.slice(offset), offset);
}

/** Preserve original code bytes while applying legacy prose transformations. */
export function mapMarkdownOutsideCode(
  text: string,
  transform: (prose: string, sourceOffset: number) => string,
  options: { handleInlineTaskReferences?: boolean } = {}
): string {
  if (!/[`~\t]| {4}/.test(text)) return transform(text, 0);
  if (text.length > MAX_MARKDOWN_CHARS) return text;

  // Task linkification handles inline chips and link labels itself.
  const ranges = getCodeRanges(markdownParser.parse(text), options.handleInlineTaskReferences);
  return mapOutsideRanges(text, ranges, transform);
}

const decodeLegacyEscapes = (text: string): string =>
  text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

/** Restore selected closed fences in single-line legacy envelopes, preserving detected inline spans. */
export function normalizeLegacyMarkdownEscapes(text: string): string {
  if (
    text.length > MAX_MARKDOWN_CHARS ||
    /[\r\n]/.test(text) ||
    !text.includes('\\n') ||
    !/`{3}|~{3}/.test(text)
  ) {
    return mapMarkdownOutsideCode(text, decodeLegacyEscapes);
  }

  const escapeOffsets: number[] = [];
  const decoded = text.replace(/\\[nt]/g, (escape: string, offset: number) => {
    escapeOffsets.push(offset - escapeOffsets.length);
    return escape === '\\n' ? '\n' : '\t';
  });
  const sourceOffset = (offset: number): number => {
    let low = 0;
    let high = escapeOffsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (escapeOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  };

  // A leading tilde fence otherwise swallows the entire serialized line as code.
  // A prose prefix exposes only its original inline spans; source offsets stay exact.
  const prefix = 'x ';
  const readInlineRanges = (source: string): Pick<CodeRange, 'start' | 'end'>[] =>
    getCodeRanges(markdownParser.parse(prefix + source))
      .filter((range) => range.type === 'inlineCode')
      .map((range) => ({ start: range.start - prefix.length, end: range.end - prefix.length }));
  const candidates: { start: number; end: number; markerStart: number; markerEnd: number }[] = [];
  for (const node of markdownParser.parse(decoded).children) {
    if (node.type !== 'code') continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const source = decoded.slice(start, end);
    const firstLineEnd = source.indexOf('\n');
    if (firstLineEnd < 0) continue;
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(source.slice(0, firstLineEnd));
    const lastLineStart = source.lastIndexOf('\n') + 1;
    const lastLine = source.slice(lastLineStart);
    let closingEnd = lastLine.length;
    while (
      closingEnd > 0 &&
      (lastLine[closingEnd - 1] === ' ' || lastLine[closingEnd - 1] === '\t')
    ) {
      closingEnd -= 1;
    }
    const closer = /^ {0,3}(`{3,}|~{3,})$/.exec(lastLine.slice(0, closingEnd));
    if (!opener || !closer?.[1].startsWith(opener[1])) continue;
    candidates.push({
      start: sourceOffset(start),
      end: sourceOffset(end),
      markerStart: sourceOffset(start + opener[0].indexOf(opener[1])),
      markerEnd: sourceOffset(
        start + lastLineStart + closer[0].indexOf(closer[1]) + closer[1].length
      ),
    });
  }
  if (candidates.length === 0) return mapMarkdownOutsideCode(text, decodeLegacyEscapes);

  // Fence bodies must not pair their backticks with unrelated inline prose.
  // Equal-length masking retains exact source positions for the outside spans.
  const maskFences = (fences: readonly Pick<CodeRange, 'start' | 'end'>[]): string => {
    let masked = '';
    let cursor = 0;
    for (const fence of fences) {
      masked += text.slice(cursor, fence.start) + ' '.repeat(fence.end - fence.start);
      cursor = fence.end;
    }
    return masked + text.slice(cursor);
  };
  const originalInline = readInlineRanges(text);
  const outsideInline = readInlineRanges(maskFences(candidates));
  let originalIndex = 0;
  let outsideIndex = 0;
  let originFenceIndex = 0;
  let originInlineIndex = 0;
  const serializedFences: typeof candidates = [];
  for (const candidate of candidates) {
    const { markerStart, markerEnd } = candidate;
    while (
      originalIndex < originalInline.length &&
      originalInline[originalIndex].end <= markerStart
    ) {
      originalIndex += 1;
    }
    while (outsideIndex < outsideInline.length && outsideInline[outsideIndex].end <= markerStart) {
      outsideIndex += 1;
    }
    const original = originalInline[originalIndex];
    const outside = outsideInline[outsideIndex];
    if (outside && outside.start < markerStart) continue;
    if (original?.start === markerStart && original.end < markerEnd) {
      // An early raw close may be an inline path or a serialized body's backtick run.
      // Preserve Windows roots and line-ending closes; only same-line trailing text permits recovery.
      const nextLine = text.indexOf('\\n', original.end);
      const trailing = text
        .slice(original.end, nextLine < 0 ? text.length : nextLine)
        .replace(/\\t/g, '\t');
      if (
        /^`{3,}[ \t]*(?:[A-Za-z]:\\|\\\\)/.test(text.slice(markerStart, original.end)) ||
        trailing.trim().length === 0
      ) {
        continue;
      }
    }
    if (original && original.start < markerStart) {
      while (
        originFenceIndex < serializedFences.length &&
        serializedFences[originFenceIndex].end <= original.start
      ) {
        originFenceIndex += 1;
      }
      const originFence = serializedFences[originFenceIndex];
      while (
        originInlineIndex < outsideInline.length &&
        outsideInline[originInlineIndex].end <= original.start
      ) {
        originInlineIndex += 1;
      }
      // A raw span opened at an outside literal's closing tick is also a body/prose pairing.
      const originInline = outsideInline[originInlineIndex];
      if (
        (!originFence || originFence.start > original.start) &&
        (!originInline || originInline.start >= original.start)
      ) {
        continue;
      }
    }
    serializedFences.push(candidate);
  }
  if (serializedFences.length === 0) return mapMarkdownOutsideCode(text, decodeLegacyEscapes);

  let fenceIndex = 0;
  const preservedInline = (
    serializedFences.length === candidates.length
      ? outsideInline
      : readInlineRanges(maskFences(serializedFences))
  ).filter((range) => {
    while (
      fenceIndex < serializedFences.length &&
      serializedFences[fenceIndex].end <= range.start
    ) {
      fenceIndex += 1;
    }
    const fence = serializedFences[fenceIndex];
    return !fence || fence.start >= range.end;
  });
  return mapOutsideRanges(text, preservedInline, decodeLegacyEscapes);
}

/** Remove reserved blocks globally, then normalize only visible Markdown prose. */
export function stripAgentBlocksForMarkdown(text: string): string {
  const stripped = stripAgentBlocks(text, { normalizeWhitespace: false });
  return mapMarkdownOutsideCode(stripped, (prose) => prose.replace(/\n{3,}/g, '\n\n')).trim();
}
