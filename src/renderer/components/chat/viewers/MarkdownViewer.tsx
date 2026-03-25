import React from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';

import { api } from '@renderer/api';
import { CopyButton } from '@renderer/components/common/CopyButton';
import { MemberHoverCard } from '@renderer/components/team/members/MemberHoverCard';
import { TaskTooltip } from '@renderer/components/team/TaskTooltip';
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
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { REHYPE_PLUGINS, REHYPE_PLUGINS_NO_HIGHLIGHT } from '@renderer/utils/markdownPlugins';
import { nameColorSet } from '@renderer/utils/projectColor';
import { parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import { FileText, UsersRound } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import {
  createSearchContext,
  EMPTY_SEARCH_MATCHES,
  highlightSearchInChildren,
  type SearchContext,
} from '../searchHighlightUtils';
import { highlightLine } from '../viewers/syntaxHighlighter';

import { FileLink, isRelativeUrl } from './FileLink';
import { MermaidDiagram } from './MermaidDiagram';

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
  /** Optional override for search highlighting (local search, e.g. Claude logs) */
  searchQueryOverride?: string;
  /** When true, shows a copy button (overlay when no label, inline in header when label exists) */
  copyable?: boolean;
  /** When true, renders without wrapper background/border (for embedding inside cards) */
  bare?: boolean;
  /** Base directory for resolving relative URLs (images, links) via local-resource:// protocol */
  baseDir?: string;
  /** Optional precomputed team color map to avoid subscribing to the full team list. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Optional team click handler to avoid subscribing to store in leaf renderers. */
  onTeamClick?: (teamName: string) => void;
}

const EMPTY_TEAMS: { teamName?: string; displayName?: string; color?: string }[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const NOOP_TEAM_CLICK = (): void => undefined;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Custom URL transform that preserves task://, mention://, and team:// protocols.
 * react-markdown v10 strips non-standard protocols by default.
 */
function allowCustomProtocols(url: string): string {
  if (url.startsWith('task://') || url.startsWith('mention://') || url.startsWith('team://'))
    return url;
  return defaultUrlTransform(url);
}

/**
 * Set of standard HTML element tag names.
 * Used to filter out non-HTML XML-like tags (e.g. `<your-name>`, `<info_for_agent>`)
 * that appear in agent messages and cause React "unrecognized tag" warnings.
 */
const STANDARD_HTML_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
  // SVG elements commonly used inline
  'svg',
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'g',
  'defs',
  'use',
  'text',
  'tspan',
  'clippath',
  'mask',
  'pattern',
  'image',
  'foreignobject',
]);

/**
 * Filter for react-markdown's `allowElement` prop.
 * Returns false for non-standard HTML tags (e.g. `<your-name>`, `<info_for_agent>`),
 * which causes react-markdown to render their text content instead of the element.
 * This prevents React "unrecognized tag" warnings from XML-like tags in agent messages.
 */
function isAllowedElement(element: { tagName: string }): boolean {
  return STANDARD_HTML_TAGS.has(element.tagName.toLowerCase());
}

/** Resolve a relative path to an absolute path given a base directory */
function resolveRelativePath(relativeSrc: string, baseDir: string): string {
  const cleaned = relativeSrc.startsWith('./') ? relativeSrc.slice(2) : relativeSrc;
  return `${baseDir}/${cleaned}`;
}

// =============================================================================
// LocalImage — loads images via IPC (readBinaryPreview) for local file access
// =============================================================================

interface LocalImageProps {
  src: string;
  alt?: string;
  baseDir: string;
}

const LocalImage = React.memo(function LocalImage({
  src,
  alt,
  baseDir,
}: LocalImageProps): React.ReactElement {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(false);

    const fullPath = resolveRelativePath(src, baseDir);
    window.electronAPI.editor
      .readBinaryPreview(fullPath)
      .then((result) => {
        if (!cancelled) {
          setDataUrl(`data:${result.mimeType};base64,${result.base64}`);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src, baseDir]);

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        [Image: {alt || src}]
      </span>
    );
  }

  if (!dataUrl) {
    return (
      <span className="inline-block size-4 animate-pulse rounded bg-surface-raised align-middle" />
    );
  }

  return <img src={dataUrl} alt={alt || ''} className="my-2 max-w-full rounded" />;
});

/** Extract plain text from a hast (HTML AST) node tree */
interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

function hastToText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.children) return node.children.map(hastToText).join('');
  return '';
}

// =============================================================================
// Component factories
// =============================================================================

function createViewerMarkdownComponents(
  searchCtx: SearchContext | null,
  isLight = false,
  teamColorByName: ReadonlyMap<string, string> = new Map(),
  onTeamClick?: (teamName: string) => void
): Components {
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
    // task:// links render with TaskTooltip + are clickable via ancestor onClickCapture
    // mention:// links render as colored inline badges
    a: ({ href, children }) => {
      if (href?.startsWith('mention://')) {
        const path = href.slice('mention://'.length);
        const slashIdx = path.indexOf('/');
        let color = '';
        let memberName = '';
        try {
          color = slashIdx >= 0 ? decodeURIComponent(path.slice(0, slashIdx)) : '';
          memberName = slashIdx >= 0 ? decodeURIComponent(path.slice(slashIdx + 1)) : '';
        } catch {
          // malformed percent-encoding — use empty color/name
        }
        const colorSet = getTeamColorSet(color);
        const bg = getThemedBadge(colorSet, isLight);
        const badge = (
          <span
            style={{
              backgroundColor: bg,
              color: colorSet.text,
              borderRadius: '3px',
              boxShadow: `0 0 0 1.5px ${bg}`,
              fontSize: 'inherit',
              cursor: 'default',
            }}
          >
            {children}
          </span>
        );
        if (memberName) {
          return (
            <MemberHoverCard name={memberName} color={color}>
              {badge}
            </MemberHoverCard>
          );
        }
        return badge;
      }
      if (href?.startsWith('team://')) {
        let teamLabel = '';
        try {
          teamLabel = decodeURIComponent(href.slice('team://'.length));
        } catch {
          // malformed percent-encoding — fall back to deterministic name color
        }
        const teamColor = teamColorByName.get(teamLabel);
        const colorSet = teamColor ? getTeamColorSet(teamColor) : nameColorSet(teamLabel, isLight);
        const bg = getThemedBadge(colorSet, isLight);
        const badgeStyle: React.CSSProperties = {
          backgroundColor: bg,
          color: colorSet.text,
          borderRadius: '3px',
          boxShadow: `0 0 0 1.5px ${bg}`,
          fontSize: 'inherit',
          cursor: onTeamClick ? 'pointer' : 'default',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2px',
          border: 'none',
          padding: 0,
          font: 'inherit',
          lineHeight: 'inherit',
        };
        if (onTeamClick && teamLabel) {
          return (
            <button
              type="button"
              style={badgeStyle}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTeamClick(teamLabel);
              }}
            >
              <UsersRound size={11} style={{ flexShrink: 0 }} />
              {children}
            </button>
          );
        }
        return (
          <span style={badgeStyle}>
            <UsersRound size={11} style={{ flexShrink: 0 }} />
            {children}
          </span>
        );
      }
      if (href?.startsWith('task://')) {
        const parsedTaskLink = parseTaskLinkHref(href);
        const taskId = parsedTaskLink?.taskId;
        if (!taskId) {
          return <>{children}</>;
        }
        return (
          <TaskTooltip taskId={taskId} teamName={parsedTaskLink?.teamName}>
            <a
              href={href}
              className="cursor-pointer font-medium no-underline hover:underline"
              style={{ color: PROSE_LINK }}
              onClick={(e) => e.preventDefault()}
            >
              {children}
            </a>
          </TaskTooltip>
        );
      }
      // Relative file paths — open in built-in editor or copy path
      if (href && isRelativeUrl(href)) {
        return <FileLink href={href}>{children}</FileLink>;
      }
      return (
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
      );
    },

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
        const lang = codeClassName?.replace('language-', '') ?? '';
        const raw = typeof children === 'string' ? children : '';
        const text = raw.replace(/\n$/, '');
        const lines = text.split('\n');
        return (
          <code
            className={`font-mono text-xs ${codeClassName ?? ''}`.trim()}
            style={{ color: COLOR_TEXT }}
          >
            {lines.map((line, i) => (
              <React.Fragment key={i}>
                {hl(highlightLine(line, lang))}
                {i < lines.length - 1 ? '\n' : null}
              </React.Fragment>
            ))}
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

    // Code blocks — intercept mermaid diagrams at the pre level
    pre: ({ children, node }) => {
      // Check if this pre contains a mermaid code block
      const codeEl = node?.children?.[0];
      if (codeEl && 'tagName' in codeEl && codeEl.tagName === 'code' && 'properties' in codeEl) {
        const cls = (codeEl.properties as Record<string, unknown>)?.className;
        if (Array.isArray(cls) && cls.some((c) => String(c) === 'language-mermaid')) {
          return <MermaidDiagram code={hastToText(codeEl as unknown as HastNode)} />;
        }
      }

      return (
        <pre
          className="my-3 max-w-full overflow-x-auto rounded-lg p-3 text-xs leading-relaxed"
          style={{
            backgroundColor: PROSE_PRE_BG,
            border: `1px solid ${PROSE_PRE_BORDER}`,
          }}
        >
          {children}
        </pre>
      );
    },

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
  searchQueryOverride,
  copyable = false,
  bare = false,
  baseDir,
  teamColorByName: providedTeamColorByName,
  onTeamClick: providedOnTeamClick,
}) => {
  const [showRaw, setShowRaw] = React.useState(false);
  const [rawLimit, setRawLimit] = React.useState(LARGE_PREVIEW_CHARS);
  const { isLight } = useTheme();
  const teams = useStore((s) => (providedTeamColorByName ? EMPTY_TEAMS : s.teams));
  const openTeamTab = useStore((s) => (providedOnTeamClick ? NOOP_TEAM_CLICK : s.openTeamTab));

  const fallbackTeamColorByName = React.useMemo(() => {
    const result = new Map<string, string>();
    for (const team of teams) {
      if (team.teamName) {
        result.set(team.teamName, team.color ?? '');
      }
      if (team.displayName) {
        result.set(team.displayName, team.color ?? '');
      }
    }
    return result;
  }, [teams]);
  const teamColorByName =
    providedTeamColorByName ?? fallbackTeamColorByName ?? EMPTY_TEAM_COLOR_MAP;
  const onTeamClick = providedOnTeamClick ?? openTeamTab;

  const isTooLarge = content.length > MAX_MARKDOWN_CHARS;
  const disableHighlight = content.length > DISABLE_HIGHLIGHT_CHARS;

  // Only re-render if THIS item has search matches
  const { searchQuery, searchMatches, currentSearchIndex } = useStore(
    useShallow((s) => {
      const hasMatch = itemId ? s.searchMatchItemIds.has(itemId) : false;
      return {
        searchQuery: hasMatch ? s.searchQuery : '',
        searchMatches: hasMatch ? s.searchMatches : EMPTY_SEARCH_MATCHES,
        currentSearchIndex: hasMatch ? s.currentSearchIndex : -1,
      };
    })
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
  const effectiveQuery = (searchQueryOverride ?? searchQuery).trim();
  const effectiveMatches = searchQueryOverride ? [] : searchMatches;
  const effectiveIndex = searchQueryOverride ? -1 : currentSearchIndex;
  const searchCtx =
    effectiveQuery && itemId
      ? createSearchContext(effectiveQuery, itemId, effectiveMatches, effectiveIndex)
      : null;
  // Local search (Claude logs): use bright highlight for all matches (no "current result" concept).
  if (searchCtx && searchQueryOverride) {
    searchCtx.forceAllActive = true;
  }

  // Create markdown components with optional search highlighting
  // When search is active, create fresh each render (match counter is stateful and must start at 0)
  // useMemo would cache stale closures when parent re-renders without search deps changing
  const baseComponents = searchCtx
    ? createViewerMarkdownComponents(searchCtx, isLight, teamColorByName, onTeamClick)
    : isLight
      ? createViewerMarkdownComponents(null, true, teamColorByName, onTeamClick)
      : createViewerMarkdownComponents(null, false, teamColorByName, onTeamClick);

  // When baseDir is set (editor preview), override img to load local files via IPC
  const components = baseDir
    ? {
        ...baseComponents,
        img: ({ src, alt }: { src?: string; alt?: string }) => {
          if (src && isRelativeUrl(src)) {
            return <LocalImage src={src} alt={alt} baseDir={baseDir} />;
          }
          return <img src={src} alt={alt || ''} className="my-2 max-w-full rounded" />;
        },
      }
    : baseComponents;

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
            rehypePlugins={disableHighlight ? REHYPE_PLUGINS_NO_HIGHLIGHT : REHYPE_PLUGINS}
            components={components}
            urlTransform={allowCustomProtocols}
            allowElement={isAllowedElement}
            unwrapDisallowed
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
