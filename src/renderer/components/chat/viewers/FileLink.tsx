/**
 * FileLink — clickable file path link for markdown content.
 * Opens the file in the built-in editor (team context) or copies the absolute path (session context).
 *
 * Follows the LocalImage pattern (MarkdownViewer.tsx) — a standalone React component
 * used inside react-markdown's `a` component factory.
 */

import React from 'react';

import { PROSE_LINK } from '@renderer/constants/cssVariables';
import { useStore } from '@renderer/store';
import { resolveFilePath } from '@renderer/store/utils/pathResolution';
import { Check, FileCode } from 'lucide-react';

import type { AppState } from '@renderer/store/types';

// =============================================================================
// Exported utilities
// =============================================================================

/** Parse "path:line" format (e.g. "src/foo.ts:42") */
export function parsePathWithLine(href: string): { filePath: string; line: number | null } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }
  const match = /^(.+?):(\d+)$/.exec(decoded);
  if (match) return { filePath: match[1], line: parseInt(match[2], 10) };
  return { filePath: decoded, line: null };
}

/**
 * Check if an href should be treated as a local file path rather than an external URL.
 * This includes repo-relative paths and absolute filesystem paths like `/Users/me/file.ts`.
 */
export function isRelativeUrl(url: string): boolean {
  return (
    !!url &&
    !url.startsWith('#') &&
    !url.includes('://') &&
    !url.startsWith('data:') &&
    !url.startsWith('mailto:')
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

export function resolveFileLinkPath(filePath: string, projectPath: string): string {
  return normalizePathSegments(resolveFilePath(projectPath, filePath));
}

function normalizePathSegments(filePath: string): string {
  const hasBackslash = filePath.includes('\\') && !filePath.includes('/');
  const separator = hasBackslash ? '\\' : '/';
  const normalized = filePath.replace(/[/\\]+/g, separator);

  let prefix = '';
  let body = normalized;

  const driveMatch = /^([A-Za-z]:)[\\/]/.exec(normalized);
  if (driveMatch) {
    prefix = `${driveMatch[1]}${separator}`;
    body = normalized.slice(prefix.length);
  } else if (normalized.startsWith(`${separator}${separator}`)) {
    prefix = `${separator}${separator}`;
    body = normalized.slice(2);
  } else if (normalized.startsWith(separator)) {
    prefix = separator;
    body = normalized.slice(1);
  }

  const segments: string[] = [];
  for (const segment of body.split(/[\\/]/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!prefix) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return prefix || '.';
  }

  return `${prefix}${segments.join(separator)}`;
}

/** Project path based on active tab context (avoids stale cross-tab state) */
function selectContextProjectPath(s: AppState): string | null {
  const activeTab = s.openTabs.find((t) => t.id === s.activeTabId);
  if (!activeTab) return null;

  switch (activeTab.type) {
    case 'team':
      return s.selectedTeamData?.config.projectPath ?? null;
    case 'session':
      return s.sessionDetail?.session?.projectPath ?? null;
    default:
      return null;
  }
}

function selectIsTeamTab(s: AppState): boolean {
  const activeTab = s.openTabs.find((t) => t.id === s.activeTabId);
  return activeTab?.type === 'team';
}

// =============================================================================
// Component
// =============================================================================

interface FileLinkProps {
  href: string;
  children: React.ReactNode;
}

export const FileLink = React.memo(function FileLink({
  href,
  children,
}: FileLinkProps): React.ReactElement {
  const projectPath = useStore(selectContextProjectPath);
  const isTeamTab = useStore(selectIsTeamTab);
  const [copied, setCopied] = React.useState(false);

  if (!projectPath) {
    return (
      <span className="font-mono text-xs" style={{ color: PROSE_LINK }}>
        {children}
      </span>
    );
  }

  const { filePath, line } = parsePathWithLine(href);
  const absolutePath = resolveFileLinkPath(filePath, projectPath);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();

    if (isTeamTab) {
      const { revealFileInEditor, setPendingGoToLine } = useStore.getState();
      if (line !== null) setPendingGoToLine(line);
      revealFileInEditor(absolutePath);
    } else {
      void navigator.clipboard.writeText(absolutePath).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => {
          // Clipboard API may not be available in all contexts
        }
      );
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-0.5 no-underline hover:underline"
      style={{
        color: PROSE_LINK,
        backgroundColor: 'var(--path-highlight-bg)',
      }}
      title={isTeamTab ? absolutePath : `Click to copy: ${absolutePath}`}
    >
      <FileCode size={12} className="shrink-0 opacity-60" />
      {children}
      {copied && <Check size={10} className="shrink-0 text-green-400" />}
    </a>
  );
});
