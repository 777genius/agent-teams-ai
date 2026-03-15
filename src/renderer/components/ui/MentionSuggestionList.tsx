import { useEffect, useRef } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { getTeamColorSet, getThemedText } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { nameColorSet } from '@renderer/utils/projectColor';
import { Folder, Hash, Loader2, UsersRound } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';

interface MentionSuggestionListProps {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  onSelect: (s: MentionSuggestion) => void;
  query: string;
  /** When true, adjusts empty state text to mention files */
  hasFileSearch?: boolean;
  /** When true, shows a loading spinner for file search */
  filesLoading?: boolean;
}

const HighlightedName = ({ name, query }: { name: string; query: string }): React.JSX.Element => {
  if (!query) return <span>{name}</span>;

  const lower = name.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);

  if (idx < 0) return <span>{name}</span>;

  const before = name.slice(0, idx);
  const match = name.slice(idx, idx + query.length);
  const after = name.slice(idx + query.length);

  return (
    <span>
      {before}
      <span className="bg-[var(--color-accent)]/25 rounded text-[var(--color-text)]">{match}</span>
      {after}
    </span>
  );
};

/** Section header for grouped suggestion lists */
const SectionHeader = ({ label }: { label: string }): React.JSX.Element => (
  <li className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
    {label}
  </li>
);

export const MentionSuggestionList = ({
  suggestions,
  selectedIndex,
  onSelect,
  query,
  hasFileSearch,
  filesLoading,
}: MentionSuggestionListProps): React.JSX.Element => {
  const listRef = useRef<HTMLUListElement>(null);
  const { isLight } = useTheme();

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Query by role=option to skip section headers
    const options = list.querySelectorAll('[role="option"]');
    const selected = options[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (suggestions.length === 0) {
    const emptyStateText = filesLoading
      ? 'Searching...'
      : hasFileSearch
        ? 'No matching suggestions'
        : 'No matching suggestions';
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
        {emptyStateText}
      </div>
    );
  }

  // Categorize suggestions (folders are grouped with files)
  type Section = 'member' | 'team' | 'task' | 'file';
  const getSuggestionSection = (s: MentionSuggestion): Section => {
    if (s.type === 'file' || s.type === 'folder') return 'file';
    if (s.type === 'task') return 'task';
    if (s.type === 'team') return 'team';
    return 'member';
  };

  const sectionLabel: Record<Section, string> = {
    member: 'Members',
    team: 'Teams',
    task: 'Tasks',
    file: 'Files',
  };

  // Determine which sections are present
  const presentSections = new Set(suggestions.map(getSuggestionSection));
  const showSections = presentSections.size > 1;

  // Build items with section headers inserted
  const items: React.JSX.Element[] = [];
  let currentSection: Section | null = null;
  let optionIndex = 0;

  for (const s of suggestions) {
    const section = getSuggestionSection(s);
    const isFile = s.type === 'file';
    const isFolder = s.type === 'folder';
    const isFileOrFolder = isFile || isFolder;
    const isTeam = section === 'team';
    const isTask = section === 'task';
    const taskTeamColorSet =
      isTask && s.color
        ? getTeamColorSet(s.color)
        : isTask && s.teamDisplayName
          ? nameColorSet(s.teamDisplayName, isLight)
          : null;

    // Insert section header on transition
    if (showSections && section !== currentSection) {
      items.push(<SectionHeader key={`section-${section}`} label={sectionLabel[section]} />);
      currentSection = section;
    }

    const isSelected = optionIndex === selectedIndex;
    const colorSet = isFileOrFolder
      ? null
      : s.color
        ? getTeamColorSet(s.color)
        : isTeam
          ? nameColorSet(s.name)
          : null;
    const idx = optionIndex;
    optionIndex++;

    items.push(
      <li
        key={s.id}
        role="option"
        aria-selected={isSelected}
        data-index={idx}
        className={`flex cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-xs transition-colors ${
          isSelected
            ? 'bg-[var(--color-accent)]/15 ring-[var(--color-accent)]/30 text-[var(--color-text)] ring-1 ring-inset'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
        }`}
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(s);
        }}
      >
        {isFolder ? (
          <Folder size={14} className="shrink-0 text-[var(--color-text-muted)]" />
        ) : isFile ? (
          <FileIcon fileName={s.name} className="size-3.5" />
        ) : isTask ? (
          <Hash size={13} className="shrink-0 text-blue-500 dark:text-blue-400" />
        ) : isTeam ? (
          <UsersRound
            size={13}
            className="shrink-0"
            style={{
              color: colorSet ? getThemedText(colorSet, isLight) : 'var(--color-text-muted)',
            }}
          />
        ) : (
          <span
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colorSet?.border ?? 'var(--color-text-muted)' }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={isFileOrFolder ? 'truncate' : 'font-medium'}
              style={
                isTask
                  ? { color: 'var(--color-link, #60a5fa)' }
                  : colorSet
                    ? { color: getThemedText(colorSet, isLight) }
                    : undefined
              }
            >
              <HighlightedName name={isTask ? `#${s.name}` : s.name} query={query} />
            </span>
            {!isTask && !isFileOrFolder && s.subtitle ? (
              <span className="truncate text-[var(--color-text-muted)]">{s.subtitle}</span>
            ) : null}
            {isTask && s.ownerName ? (
              <MemberBadge name={s.ownerName} color={s.ownerColor} size="xs" disableHoverCard />
            ) : null}
            {isTask && s.teamDisplayName ? (
              <span
                className="truncate text-[10px]"
                style={
                  taskTeamColorSet ? { color: getThemedText(taskTeamColorSet, isLight) } : undefined
                }
              >
                {s.teamDisplayName}
              </span>
            ) : null}
          </div>
          {isTask && s.subtitle ? (
            <div className="truncate text-[10px] text-[var(--color-text-muted)]">{s.subtitle}</div>
          ) : null}
        </div>
        {isTeam && s.isOnline !== undefined ? (
          <span
            className="inline-block size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: s.isOnline ? '#22c55e' : '#71717a' }}
            title={s.isOnline ? 'Online' : 'Offline'}
          />
        ) : null}
        {s.subtitle && isFileOrFolder ? (
          <span
            className="truncate text-[var(--color-text-muted)]"
            style={{ direction: 'rtl', textAlign: 'left' }}
          >
            {'\u200E' + s.subtitle}
          </span>
        ) : null}
      </li>
    );
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      className="max-h-48 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] py-1"
    >
      {items}
      {filesLoading ? (
        <li className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
          <Loader2 size={10} className="shrink-0 animate-spin" />
          <span>Searching files...</span>
        </li>
      ) : null}
    </ul>
  );
};
