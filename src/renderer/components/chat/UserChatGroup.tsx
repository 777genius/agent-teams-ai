import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';

import { api } from '@renderer/api';
import { MemberHoverCard } from '@renderer/components/team/members/MemberHoverCard';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTabUI } from '@renderer/hooks/useTabUI';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { REHYPE_PLUGINS } from '@renderer/utils/markdownPlugins';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { parseTaskNotifications } from '@shared/utils/contentSanitizer';
import { createLogger } from '@shared/utils/logger';
import { format } from 'date-fns';
import { CheckCircle, ChevronDown, ChevronUp, Circle, FileText, User, XCircle } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import { CopyButton } from '../common/CopyButton';
import { extractTextFromReactNode } from './markdownCopyUtils';
import {
  createSearchContext,
  EMPTY_SEARCH_MATCHES,
  highlightSearchInChildren,
  type SearchContext,
} from './searchHighlightUtils';

import type { UserGroup } from '@renderer/types/groups';

const logger = createLogger('Component:UserChatGroup');

// Pattern for @paths only (file references)
const PATH_PATTERN = /@([^\s,)}\]]+)/g;

interface UserChatGroupProps {
  userGroup: UserGroup;
}

/**
 * Recursively walks React children and replaces text nodes containing @path
 * references with styled spans using validated path state.
 */
// eslint-disable-next-line sonarjs/function-return-type -- React child manipulation inherently returns mixed node types
function highlightTextNode(text: string, validatedPaths: Record<string, boolean>): React.ReactNode {
  const pathPattern = /@[^\s,)}\]]+/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  pathPattern.lastIndex = 0;
  while ((match = pathPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const fullMatch = match[0];
    const isValid = validatedPaths[fullMatch] === true;

    if (isValid) {
      parts.push(
        <span
          key={match.index}
          style={{
            backgroundColor: 'var(--chat-user-tag-bg)',
            color: 'var(--chat-user-tag-text)',
            padding: '0.125rem 0.375rem',
            borderRadius: '0.25rem',
            border: '1px solid var(--chat-user-tag-border)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '0.8125em',
          }}
        >
          {fullMatch}
        </span>
      );
    } else {
      parts.push(fullMatch);
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  if (parts.length === 0) return text;
  if (parts.length === 1) return parts[0];
  return parts;
}

// eslint-disable-next-line sonarjs/function-return-type -- React child manipulation inherently returns mixed node types
function highlightPaths(
  children: React.ReactNode,
  validatedPaths: Record<string, boolean>
): React.ReactNode {
  // eslint-disable-next-line sonarjs/function-return-type -- React child manipulation inherently returns mixed node types
  return React.Children.map(children, (child): React.ReactNode => {
    if (typeof child === 'string') {
      return highlightTextNode(child, validatedPaths);
    }

    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
      return React.cloneElement(
        child,
        undefined,
        highlightPaths(child.props.children, validatedPaths)
      );
    }

    return child;
  });
}

/**
 * Custom URL transform that preserves mention:// protocol.
 * react-markdown strips non-standard protocols by default.
 */
function allowMentionProtocol(url: string): string {
  if (url.startsWith('mention://')) return url;
  return defaultUrlTransform(url);
}

/**
 * Creates markdown components for user bubble rendering.
 * Uses chat-user CSS variables for consistent styling and wraps
 * text-bearing elements through highlightPaths for @path tag injection
 * and optional search term highlighting.
 */
function createUserMarkdownComponents(
  validatedPaths: Record<string, boolean>,
  searchCtx: SearchContext | null,
  isLight = false
): Components {
  const userTextColor = 'var(--chat-user-text)';

  // Compose path highlighting with optional search highlighting
  // eslint-disable-next-line sonarjs/function-return-type -- React child manipulation inherently returns mixed node types
  const hl = (children: React.ReactNode): React.ReactNode => {
    const withPaths = highlightPaths(children, validatedPaths);
    return searchCtx ? highlightSearchInChildren(withPaths, searchCtx) : withPaths;
  };

  return {
    h1: ({ children }) => (
      <h1 className="mb-3 mt-6 text-lg font-semibold first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-5 text-base font-semibold first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-2 mt-4 text-sm font-semibold first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1 mt-2 text-xs font-medium first:mt-0" style={{ color: userTextColor }}>
        {hl(children)}
      </h6>
    ),

    p: ({ children }) => (
      <p
        className="my-2 text-sm leading-relaxed first:mt-0 last:mb-0"
        style={{ color: userTextColor }}
      >
        {hl(children)}
      </p>
    ),

    // Inline elements — no hl(); parent block element's hl() descends here
    // mention:// links render as colored badges with MemberHoverCard
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
          // malformed percent-encoding
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
      return (
        <a
          href={href}
          className="no-underline hover:underline"
          style={{ color: 'var(--chat-user-tag-text)' }}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },

    strong: ({ children }) => (
      <strong className="font-semibold" style={{ color: userTextColor }}>
        {children}
      </strong>
    ),

    em: ({ children }) => (
      <em className="italic" style={{ color: userTextColor }}>
        {children}
      </em>
    ),

    del: ({ children }) => (
      <del className="line-through" style={{ color: userTextColor }}>
        {children}
      </del>
    ),

    code: ({ className, children }) => {
      const hasLanguageClass = className?.includes('language-');
      const content = typeof children === 'string' ? children : '';
      const isMultiLine = content.includes('\n');
      const isBlock = (hasLanguageClass ?? false) || isMultiLine;

      if (isBlock) {
        return (
          <code
            className={`block font-mono text-xs ${className ?? ''}`.trim()}
            style={{ color: userTextColor }}
          >
            {hl(children)}
          </code>
        );
      }
      // Inline code — no hl()
      return (
        <code
          className="rounded px-1.5 py-0.5 font-mono text-xs"
          style={{
            backgroundColor: 'var(--chat-user-tag-bg)',
            color: 'var(--chat-user-tag-text)',
            border: '1px solid var(--chat-user-tag-border)',
          }}
        >
          {children}
        </code>
      );
    },

    pre: ({ children }) => {
      const codeText = extractTextFromReactNode(children).trim();

      return (
        <pre
          className={`my-3 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed ${codeText ? 'group relative' : ''}`.trim()}
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
            border: '1px solid var(--chat-user-tag-border)',
            color: userTextColor,
          }}
        >
          {codeText ? <CopyButton text={codeText} bgColor="var(--chat-user-bg)" /> : null}
          {children}
        </pre>
      );
    },

    blockquote: ({ children }) => (
      <blockquote
        className="my-3 border-l-4 pl-4 italic"
        style={{
          borderColor: 'var(--chat-user-tag-border)',
          color: userTextColor,
        }}
      >
        {hl(children)}
      </blockquote>
    ),

    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-5" style={{ color: userTextColor }}>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5" style={{ color: userTextColor }}>
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="text-sm" style={{ color: userTextColor }}>
        {hl(children)}
      </li>
    ),

    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table
          className="min-w-full border-collapse text-sm"
          style={{ borderColor: 'var(--chat-user-tag-border)' }}
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead style={{ backgroundColor: 'rgba(0, 0, 0, 0.1)' }}>{children}</thead>
    ),
    th: ({ children }) => (
      <th
        className="px-3 py-2 text-left font-semibold"
        style={{
          border: '1px solid var(--chat-user-tag-border)',
          color: userTextColor,
        }}
      >
        {hl(children)}
      </th>
    ),
    td: ({ children }) => (
      <td
        className="px-3 py-2"
        style={{
          border: '1px solid var(--chat-user-tag-border)',
          color: userTextColor,
        }}
      >
        {hl(children)}
      </td>
    ),

    hr: () => <hr className="my-4" style={{ borderColor: 'var(--chat-user-tag-border)' }} />,
  };
}

/**
 * UserChatGroup displays a user's input message.
 * Features:
 * - Right-aligned bubble layout with subtle blue styling
 * - Header with user icon, label, and timestamp
 * - Markdown rendering with inline highlighted mentions (@paths)
 * - Copy button on hover
 * - Toggle for long content (>500 chars)
 * - Shows image count indicator
 */
const UserChatGroupInner = ({ userGroup }: Readonly<UserChatGroupProps>): React.JSX.Element => {
  const { content, timestamp, id: groupId } = userGroup;
  const [isManuallyExpanded, setIsManuallyExpanded] = useState(false);
  const [validatedPaths, setValidatedPaths] = useState<Record<string, boolean>>({});
  const { isLight } = useTheme();

  // Get projectPath from per-tab session data, falling back to global state
  const { tabId } = useTabUI();
  const projectPath = useStore((s) => {
    const td = tabId ? s.tabSessionData[tabId] : null;
    return (td?.sessionDetail ?? s.sessionDetail)?.session?.projectPath;
  });

  // Get team members for @mention highlighting and team names for @team linkification
  const { members, teams } = useStore(
    useShallow((s) => ({
      members: s.selectedTeamData?.members,
      teams: s.teams,
    }))
  );
  const memberColorMap = useMemo(
    () => (members ? buildMemberColorMap(members) : new Map<string, string>()),
    [members]
  );
  const teamNames = useMemo(
    () => teams.filter((t) => !t.deletedAt).map((t) => t.teamName),
    [teams]
  );

  // Get search state for highlighting — only re-render if THIS item has matches
  const { searchQuery, searchMatches, currentSearchIndex } = useStore(
    useShallow((s) => {
      const hasMatch = s.searchMatchItemIds.has(groupId);
      return {
        searchQuery: hasMatch ? s.searchQuery : '',
        searchMatches: hasMatch ? s.searchMatches : EMPTY_SEARCH_MATCHES,
        currentSearchIndex: hasMatch ? s.currentSearchIndex : -1,
      };
    })
  );

  const hasImages = content.images.length > 0;
  // Use rawText to preserve /commands inline
  const textContent = content.rawText ?? content.text ?? '';
  const stripped = useMemo(() => stripAgentBlocks(textContent), [textContent]);
  const isLongContent = stripped.length > 500;

  const taskNotifications = useMemo(() => {
    const rawContent =
      typeof userGroup.message.content === 'string'
        ? userGroup.message.content
        : Array.isArray(userGroup.message.content)
          ? userGroup.message.content
              .filter((block): block is { type: 'text'; text: string } => {
                return (
                  typeof block === 'object' &&
                  block !== null &&
                  'type' in block &&
                  'text' in block &&
                  (block as { type?: unknown }).type === 'text' &&
                  typeof (block as { text?: unknown }).text === 'string'
                );
              })
              .map((block) => block.text)
              .join('')
          : '';

    return parseTaskNotifications(rawContent);
  }, [userGroup.message.content]);

  // Extract @path mentions from text
  const pathMentions = useMemo(() => {
    if (!textContent) return [];
    const result: { value: string; raw: string }[] = [];
    const pathPattern = new RegExp(PATH_PATTERN.source, PATH_PATTERN.flags);
    let match;
    while ((match = pathPattern.exec(textContent)) !== null) {
      result.push({ value: match[1], raw: match[0] });
    }
    return result;
  }, [textContent]);

  // Validate @path mentions via IPC
  useEffect(() => {
    if (pathMentions.length === 0 || !projectPath) return;
    let isCurrent = true;

    const validatePaths = async (): Promise<void> => {
      try {
        const toValidate = pathMentions.map((m) => ({ type: 'path' as const, value: m.value }));
        const results = await api.validateMentions(toValidate, projectPath);
        if (isCurrent) {
          setValidatedPaths(results);
        }
      } catch (err) {
        logger.error('Path validation failed:', err);
        if (isCurrent) {
          setValidatedPaths({});
        }
      }
    };

    void validatePaths();
    return () => {
      isCurrent = false;
    };
  }, [textContent, projectPath, pathMentions]);

  const effectiveValidatedPaths = useMemo(
    () => (pathMentions.length === 0 || !projectPath ? {} : validatedPaths),
    [pathMentions.length, projectPath, validatedPaths]
  );

  // Create search context (fresh each render so counter starts at 0)
  const searchCtx = searchQuery
    ? createSearchContext(searchQuery, groupId, searchMatches, currentSearchIndex)
    : null;

  // Base markdown components (no search) — safe to memoize
  const userMarkdownComponentsBase = useMemo(
    () => createUserMarkdownComponents(effectiveValidatedPaths, null, isLight),
    [effectiveValidatedPaths, isLight]
  );
  // When search is active, create fresh each render (match counter is stateful and must start at 0)
  // useMemo would cache stale closures when parent re-renders without search deps changing
  const userMarkdownComponents = searchCtx
    ? createUserMarkdownComponents(effectiveValidatedPaths, searchCtx, isLight)
    : userMarkdownComponentsBase;

  // Auto-expand when search is active and this message has ANY matches.
  // Without this, the pre-counter searches full text but the renderer only
  // shows the first 500 chars — creating phantom matches.
  const shouldAutoExpand = useMemo(() => {
    if (!searchQuery || !isLongContent) return false;
    return searchMatches.some((m) => m.itemId === groupId);
  }, [searchQuery, isLongContent, searchMatches, groupId]);

  // Combined expansion state: manual toggle or auto-expand for search
  const isExpanded = isManuallyExpanded || shouldAutoExpand;

  const anchorRef = useRef<HTMLDivElement>(null);
  const handleCollapse = useCallback(() => {
    setIsManuallyExpanded(false);
    anchorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // Determine display text
  const baseDisplayText = isLongContent && !isExpanded ? stripped.slice(0, 500) + '...' : stripped;

  // Pre-process: convert @memberName to mention:// markdown links
  const displayText = useMemo(
    () => linkifyAllMentionsInMarkdown(baseDisplayText, memberColorMap, teamNames),
    [baseDisplayText, memberColorMap, teamNames]
  );

  return (
    <div ref={anchorRef} className="flex justify-end">
      <div className="max-w-[85%] space-y-2">
        {/* Header - right aligned with improved hierarchy */}
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {format(timestamp, 'h:mm:ss a')}
          </span>
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
            You
          </span>
          <User className="size-3.5" style={{ color: 'var(--color-text-secondary)' }} />
        </div>

        {/* Content - polished bubble with subtle depth (hide when only agent blocks) */}
        {stripped && (
          <div
            className="group relative overflow-hidden rounded-2xl rounded-br-sm px-4 py-3"
            style={{
              backgroundColor: 'var(--chat-user-bg)',
              border: '1px solid var(--chat-user-border)',
              boxShadow: 'var(--chat-user-shadow)',
            }}
          >
            <CopyButton text={stripped} bgColor="var(--chat-user-bg)" />

            <div className="text-sm" style={{ color: 'var(--chat-user-text)' }} data-search-content>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={REHYPE_PLUGINS}
                components={userMarkdownComponents}
                urlTransform={allowMentionProtocol}
              >
                {displayText}
              </ReactMarkdown>
            </div>
            {isLongContent && !isExpanded && (
              <button
                onClick={() => setIsManuallyExpanded(true)}
                className="mt-2 flex items-center gap-1 text-xs hover:opacity-80"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <ChevronDown size={12} />
                Show more
              </button>
            )}
          </div>
        )}

        {/* Sticky Show less — outside overflow-hidden bubble so sticky works */}
        {stripped && isLongContent && isExpanded ? (
          <div className="sticky bottom-0 z-10 flex justify-center pb-1 pt-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
              onClick={(e) => {
                e.stopPropagation();
                handleCollapse();
              }}
            >
              <ChevronUp size={12} />
              Show less
            </button>
          </div>
        ) : null}

        {taskNotifications.length > 0 &&
          taskNotifications.map((notification) => {
            const isCompleted = notification.status === 'completed';
            const isFailed = notification.status === 'failed' || notification.status === 'error';
            const StatusIcon = isFailed ? XCircle : isCompleted ? CheckCircle : Circle;
            const statusColor = isFailed
              ? 'var(--error-highlight-text, #ef4444)'
              : isCompleted
                ? 'var(--badge-success-text, #22c55e)'
                : 'var(--color-text-muted)';
            const commandMatch = /"([^"]+)"/.exec(notification.summary);
            const commandName =
              commandMatch?.[1] ?? notification.summary.trim() ?? 'Background task';
            const exitCodeMatch = /\(exit code (\d+)\)/.exec(notification.summary);
            const outputFileName = notification.outputFile
              ? (notification.outputFile.split(/[\\/]/).pop() ?? notification.outputFile)
              : null;

            return (
              <div
                key={notification.taskId || `${groupId}-${notification.summary}`}
                className="flex items-start gap-2.5 rounded-lg px-3 py-2"
                style={{
                  backgroundColor: 'var(--card-bg)',
                  border: '1px solid var(--card-border)',
                }}
              >
                <StatusIcon className="mt-0.5 size-3.5 shrink-0" style={{ color: statusColor }} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div
                    className="text-xs font-medium leading-snug"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {commandName || 'Background task'}
                  </div>
                  <div
                    className="flex items-center gap-2 text-[10px]"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <span className="capitalize">{notification.status || 'unknown'}</span>
                    {exitCodeMatch?.[1] ? <span>exit {exitCodeMatch[1]}</span> : null}
                    {outputFileName ? (
                      <span className="flex min-w-0 items-center gap-0.5 truncate">
                        <FileText className="size-2.5 shrink-0" />
                        <span className="truncate">{outputFileName}</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

        {/* Images indicator */}
        {hasImages && (
          <div className="text-right text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {content.images.length} image{content.images.length > 1 ? 's' : ''} attached
          </div>
        )}
      </div>
    </div>
  );
};

export const UserChatGroup = React.memo(UserChatGroupInner);
