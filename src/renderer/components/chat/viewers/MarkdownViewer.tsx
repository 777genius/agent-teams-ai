import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

import { api } from '@renderer/api';
import { CopyButton } from '@renderer/components/common/CopyButton';
import {
  CODE_BG,
  CODE_BORDER,
  CODE_HEADER_BG,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
  PROSE_BLOCKQUOTE_BORDER,
  PROSE_BODY,
  PROSE_CODE_BG,
  PROSE_CODE_TEXT,
  PROSE_HEADING,
  PROSE_LINK,
  PROSE_MUTED,
  PROSE_PRE_BG,
  PROSE_PRE_BORDER,
  PROSE_TABLE_BORDER,
  PROSE_TABLE_HEADER_BG,
} from '@renderer/constants/cssVariables';
import { useStore } from '@renderer/store';
import { REHYPE_PLUGINS } from '@renderer/utils/markdownPlugins';
import { FileText } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import {
  createSearchContext,
  highlightSearchInChildren,
  type SearchContext,
} from '../searchHighlightUtils';

// =============================================================================
// Types
// =============================================================================

interface MarkdownViewerProps {
  content: string;
  maxHeight?: string; // e.g., "max-h-64" or "max-h-96"
  className?: string;
  label?: string; // Optional label like "Thinking", "Output", etc.
  /** When provided, enables search term highlighting within the markdown */
  itemId?: string;
  /** When true, shows a copy button (overlay when no label, inline in header when label exists) */
  copyable?: boolean;
  /** When true, renders without wrapper background/border (for embedding inside cards) */
  bare?: boolean;
}

// =============================================================================
// Component factories
// =============================================================================

function createViewerMarkdownComponents(searchCtx: SearchContext | null): Components {
  const hl = (children: React.ReactNode): React.ReactNode =>
    searchCtx ? highlightSearchInChildren(children, searchCtx) : children;

  return {
    // Headings
    h1: ({ children }) => (
      <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1 mt-2 text-xs font-medium first:mt-0" style={{ color: PROSE_HEADING }}>
        {hl(children)}
      </h6>
    ),

    // Paragraphs
    p: ({ children }) => (
      <p
        className="my-2 text-sm leading-relaxed first:mt-0 last:mb-0"
        style={{ color: PROSE_BODY }}
      >
        {hl(children)}
      </p>
    ),

    // Links — inline element, no hl(); parent block element's hl() descends here
    a: ({ href, children }) => (
      <a
        href={href}
        className="cursor-pointer no-underline hover:underline"
        style={{ color: PROSE_LINK }}
        onClick={(e) => {
          e.preventDefault();
          if (href) {
            void api.openExternal(href);
          }
        }}
      >
        {children}
      </a>
    ),

    // Strong/Bold — inline element, no hl()
    strong: ({ children }) => (
      <strong className="font-semibold" style={{ color: PROSE_HEADING }}>
        {children}
      </strong>
    ),

    // Emphasis/Italic — inline element, no hl()
    em: ({ children }) => (
      <em className="italic" style={{ color: PROSE_BODY }}>
        {children}
      </em>
    ),

    // Strikethrough — inline element, no hl()
    del: ({ children }) => (
      <del className="line-through" style={{ color: PROSE_BODY }}>
        {children}
      </del>
    ),

    // Code: inline vs block detection (block code is highlighted by rehype-highlight; preserve hljs class)
    code: (props) => {
      const {
        className: codeClassName,
        children,
        node,
      } = props as {
        className?: string;
        children?: React.ReactNode;
        node?: { position?: { start: { line: number }; end: { line: number } } };
      };
      const hasLanguage = codeClassName?.includes('language-');
      const isMultiLine =
        (node?.position && node.position.end.line > node.position.start.line) ?? false;
      const isBlock = (hasLanguage ?? false) || isMultiLine;

      if (isBlock) {
        return (
          <code
            className={`font-mono text-xs ${codeClassName ?? ''}`.trim()}
            style={{ color: COLOR_TEXT }}
          >
            {hl(children)}
          </code>
        );
      }
      // Inline code — no hl(); parent block element's hl() descends here
      return (
        <code
          className="break-all rounded px-1.5 py-0.5 font-mono text-xs"
          style={{
            backgroundColor: PROSE_CODE_BG,
            color: PROSE_CODE_TEXT,
          }}
        >
          {children}
        </code>
      );
    },

    // Code blocks
    pre: ({ children }) => (
      <pre
        className="my-3 max-w-full overflow-x-auto rounded-lg p-3 text-xs leading-relaxed"
        style={{
          backgroundColor: PROSE_PRE_BG,
          border: `1px solid ${PROSE_PRE_BORDER}`,
        }}
      >
        {children}
      </pre>
    ),

    // Blockquotes
    blockquote: ({ children }) => (
      <blockquote
        className="my-3 border-l-4 pl-4 italic"
        style={{
          borderColor: PROSE_BLOCKQUOTE_BORDER,
          color: PROSE_MUTED,
        }}
      >
        {hl(children)}
      </blockquote>
    ),

    // Lists
    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-5" style={{ color: PROSE_BODY }}>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5" style={{ color: PROSE_BODY }}>
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="text-sm" style={{ color: PROSE_BODY }}>
        {hl(children)}
      </li>
    ),

    // Tables
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table
          className="min-w-full border-collapse text-sm"
          style={{ borderColor: PROSE_TABLE_BORDER }}
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead style={{ backgroundColor: PROSE_TABLE_HEADER_BG }}>{children}</thead>
    ),
    th: ({ children }) => (
      <th
        className="px-3 py-2 text-left font-semibold"
        style={{
          border: `1px solid ${PROSE_TABLE_BORDER}`,
          color: PROSE_HEADING,
        }}
      >
        {hl(children)}
      </th>
    ),
    td: ({ children }) => (
      <td
        className="px-3 py-2"
        style={{
          border: `1px solid ${PROSE_TABLE_BORDER}`,
          color: PROSE_BODY,
        }}
      >
        {hl(children)}
      </td>
    ),

    // Horizontal rule
    hr: () => <hr className="my-4" style={{ borderColor: PROSE_TABLE_BORDER }} />,
  };
}

/** Default components without search highlighting */
const defaultComponents = createViewerMarkdownComponents(null);

// Markdown + syntax highlighting can freeze the renderer on some inputs
// (very large text, huge code blocks, pathological markdown). Keep the UI responsive:
// - for medium/large content: disable syntax highlighting
// - for very large content: show a raw preview instead of parsing markdown
const DISABLE_HIGHLIGHT_CHARS = 12_000;
const MAX_MARKDOWN_CHARS = 60_000;
const LARGE_PREVIEW_CHARS = 30_000;

// =============================================================================
// Component
// =============================================================================

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  content,
  maxHeight = 'max-h-96',
  className = '',
  label,
  itemId,
  copyable = false,
  bare = false,
}) => {
  const [showRaw, setShowRaw] = React.useState(false);
  const [rawLimit, setRawLimit] = React.useState(LARGE_PREVIEW_CHARS);

  const isTooLarge = content.length > MAX_MARKDOWN_CHARS;
  const disableHighlight = content.length > DISABLE_HIGHLIGHT_CHARS;

  // Only subscribe to search store when itemId is provided
  const { searchQuery, searchMatches, currentSearchIndex } = useStore(
    useShallow((s) => ({
      searchQuery: itemId ? s.searchQuery : '',
      searchMatches: itemId ? s.searchMatches : [],
      currentSearchIndex: itemId ? s.currentSearchIndex : -1,
    }))
  );

  // Guard: very large markdown can freeze the renderer (remark/rehype + highlighting).
  // For large content, default to a lightweight raw preview with manual expansion.
  if (isTooLarge || showRaw) {
    const shown = content.slice(0, Math.min(rawLimit, content.length));
    const isTruncated = shown.length < content.length;
    return (
      <div
        className={`min-w-0 overflow-hidden ${bare ? '' : 'rounded-lg shadow-sm'} ${copyable && !label ? 'group relative' : ''} ${className}`}
        style={
          bare
            ? undefined
            : {
                backgroundColor: CODE_BG,
                border: `1px solid ${CODE_BORDER}`,
              }
        }
      >
        {copyable && !label && (
          <CopyButton text={content} bgColor={bare ? 'transparent' : undefined} />
        )}

        {label && (
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{
              backgroundColor: CODE_HEADER_BG,
              borderBottom: `1px solid ${CODE_BORDER}`,
            }}
          >
            <FileText className="size-4 shrink-0" style={{ color: COLOR_TEXT_MUTED }} />
            <span className="text-sm font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
              {label}
            </span>
            <span className="ml-2 text-[11px]" style={{ color: COLOR_TEXT_MUTED }}>
              Raw
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="text-xs underline"
              style={{ color: PROSE_LINK }}
              onClick={() => setShowRaw(false)}
              disabled={isTooLarge}
              title={
                isTooLarge
                  ? 'Large content is shown as raw to prevent UI freeze'
                  : 'Render markdown'
              }
            >
              Render markdown
            </button>
            {copyable && <CopyButton text={content} inline />}
          </div>
        )}

        {!label && (
          <div
            className="flex items-center justify-between px-3 py-2 text-xs"
            style={{ color: COLOR_TEXT_MUTED }}
          >
            <span>Raw preview</span>
            <button
              type="button"
              className="underline"
              style={{ color: PROSE_LINK }}
              onClick={() => setShowRaw(false)}
              disabled={isTooLarge}
              title={
                isTooLarge
                  ? 'Large content is shown as raw to prevent UI freeze'
                  : 'Render markdown'
              }
            >
              Render markdown
            </button>
          </div>
        )}

        {isTooLarge && (
          <div className="px-3 pb-2 text-[11px]" style={{ color: COLOR_TEXT_MUTED }}>
            Content is very large ({content.length.toLocaleString()} chars). Showing raw preview to
            keep the UI responsive.
          </div>
        )}

        <div className={`min-w-0 overflow-auto ${maxHeight}`}>
          <pre
            className="min-w-0 whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed"
            style={{ color: PROSE_BODY }}
          >
            {shown}
          </pre>
          {isTruncated && (
            <div className="flex items-center justify-between gap-2 px-4 pb-4 text-xs">
              <span style={{ color: COLOR_TEXT_MUTED }}>
                Showing {shown.length.toLocaleString()} / {content.length.toLocaleString()} chars
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: CODE_BORDER, color: PROSE_LINK }}
                  onClick={() => setRawLimit((v) => Math.min(content.length, v * 2))}
                >
                  Show more
                </button>
                <button
                  type="button"
                  className="rounded border px-2 py-1"
                  style={{ borderColor: CODE_BORDER, color: PROSE_LINK }}
                  onClick={() => setRawLimit(content.length)}
                >
                  Show all
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Create search context (fresh each render so counter starts at 0)
  const searchCtx =
    searchQuery && itemId
      ? createSearchContext(searchQuery, itemId, searchMatches, currentSearchIndex)
      : null;

  // Create markdown components with optional search highlighting
  // When search is active, create fresh each render (match counter is stateful and must start at 0)
  // useMemo would cache stale closures when parent re-renders without search deps changing
  const components = searchCtx ? createViewerMarkdownComponents(searchCtx) : defaultComponents;

  return (
    <div
      className={`min-w-0 overflow-hidden ${bare ? '' : 'rounded-lg shadow-sm'} ${copyable && !label ? 'group relative' : ''} ${className}`}
      style={
        bare
          ? undefined
          : {
              backgroundColor: CODE_BG,
              border: `1px solid ${CODE_BORDER}`,
            }
      }
    >
      {/* Copy button overlay (when no label header) */}
      {copyable && !label && (
        <CopyButton text={content} bgColor={bare ? 'transparent' : undefined} />
      )}

      {/* Optional header - matches CodeBlockViewer style */}
      {label && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            backgroundColor: CODE_HEADER_BG,
            borderBottom: `1px solid ${CODE_BORDER}`,
          }}
        >
          <FileText className="size-4 shrink-0" style={{ color: COLOR_TEXT_MUTED }} />
          <span className="text-sm font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
            {label}
          </span>
          {copyable && (
            <>
              <span className="flex-1" />
              <CopyButton text={content} inline />
            </>
          )}
        </div>
      )}

      {/* Markdown content with scroll */}
      <div className={`min-w-0 overflow-auto ${maxHeight}`}>
        <div className="min-w-0 break-words p-4">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={disableHighlight ? [] : REHYPE_PLUGINS}
            urlTransform={(url) => url}
            components={components}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
