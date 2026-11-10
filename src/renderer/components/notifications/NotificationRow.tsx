/**
 * NotificationRow - Linear Inbox-style notification row.
 * Compact, high-density layout with hover actions.
 */

import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { getTriggerColorDef } from '@shared/constants/triggerColors';
import { formatDistanceToNow } from 'date-fns';
import { ArrowRight, Bot, Check, Trash2, Users } from 'lucide-react';

import type { DetectedError } from '@renderer/types/data';

interface NotificationRowProps {
  error: DetectedError;
  onRowClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/**
 * Truncates a string to a maximum length, adding ellipsis if truncated.
 */
function truncateMessage(message: string, maxLength: number = 100): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength).trim() + '...';
}

export const NotificationRow = ({
  error,
  onRowClick,
  onArchive,
  onDelete,
}: Readonly<NotificationRowProps>): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [isHovered, setIsHovered] = useState(false);
  const isUnread = !error.isRead;
  const projectName = error.context?.projectName || 'Unknown Project';
  const relativeTime = formatDistanceToNow(new Date(error.timestamp), {
    addSuffix: true,
  });
  const truncatedMessage = truncateMessage(error.message);
  const colorDef = getTriggerColorDef(error.triggerColor);
  const displayName = error.triggerName ?? error.source;
  const isTeamNotification = error.category === 'team' || error.sessionId?.startsWith('team:');

  const handleArchiveClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onArchive();
  };

  const handleDeleteClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onDelete();
  };

  const handleNavigateClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onRowClick();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowClick();
        }
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex h-full cursor-pointer items-center gap-3 border-b px-4 transition-colors"
      style={{
        borderColor: 'var(--color-border)',
        backgroundColor: isHovered ? 'var(--color-surface-raised)' : undefined,
        opacity: isUnread ? 1 : 0.5,
      }}
    >
      {/* Color Dot — always visible, opacity indicates read state */}
      <div className="flex w-3 shrink-0 justify-center">
        <span
          className="size-2.5 rounded-full"
          style={{
            backgroundColor: colorDef.hex,
            opacity: isUnread ? 1 : 0.4,
          }}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 py-2">
        {/* Title Row */}
        <div className="flex items-center gap-1.5">
          <span
            className="truncate text-sm font-medium"
            style={{ color: isUnread ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
          >
            {displayName}
          </span>
          <span style={{ color: 'var(--color-text-muted)' }}>&middot;</span>
          <span className="truncate text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {projectName}
          </span>
          {isTeamNotification && !error.subagentId && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: 'var(--tag-bg)',
                border: '1px solid var(--tag-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              <Users className="size-3" />
              {t('notifications.row.team')}
            </span>
          )}
          {error.subagentId && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: 'var(--tag-bg)',
                border: '1px solid var(--tag-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              <Bot className="size-3" />
              {t('notifications.row.subagent')}
            </span>
          )}
        </div>
        {/* Description */}
        <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {truncatedMessage}
        </p>
      </div>

      {/* Right Side: Time or Hover Actions */}
      <div className="flex shrink-0 items-center gap-1">
        {isHovered ? (
          <HoverActions
            isUnread={isUnread}
            onArchiveClick={handleArchiveClick}
            onDeleteClick={handleDeleteClick}
            onNavigateClick={handleNavigateClick}
          />
        ) : (
          <span
            className="whitespace-nowrap text-[11px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {relativeTime}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * HoverActions - Action buttons shown on hover.
 */
interface HoverActionsProps {
  isUnread: boolean;
  onArchiveClick: (e: React.MouseEvent) => void;
  onDeleteClick: (e: React.MouseEvent) => void;
  onNavigateClick: (e: React.MouseEvent) => void;
}

const HoverActions = ({
  isUnread,
  onArchiveClick,
  onDeleteClick,
  onNavigateClick,
}: HoverActionsProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [hoveredButton, setHoveredButton] = useState<string | null>(null);

  const getButtonStyle = (buttonId: string, isDelete = false): React.CSSProperties => ({
    color:
      hoveredButton === buttonId
        ? isDelete
          ? 'var(--tool-result-error-text)'
          : 'var(--color-text)'
        : 'var(--color-text-muted)',
    backgroundColor: hoveredButton === buttonId ? 'var(--color-border-emphasis)' : undefined,
  });

  return (
    <>
      {/* Archive Button (mark as read) */}
      {isUnread && (
        <button
          onClick={onArchiveClick}
          onMouseEnter={() => setHoveredButton('archive')}
          onMouseLeave={() => setHoveredButton(null)}
          className="rounded p-1.5 transition-colors"
          style={getButtonStyle('archive')}
          title={t('notifications.row.markAsRead')}
        >
          <Check className="size-4" />
        </button>
      )}
      {/* Delete Button */}
      <button
        onClick={onDeleteClick}
        onMouseEnter={() => setHoveredButton('delete')}
        onMouseLeave={() => setHoveredButton(null)}
        className="rounded p-1.5 transition-colors"
        style={getButtonStyle('delete', true)}
        title={t('notifications.row.delete')}
      >
        <Trash2 className="size-4" />
      </button>
      {/* Navigate Button */}
      <button
        onClick={onNavigateClick}
        onMouseEnter={() => setHoveredButton('navigate')}
        onMouseLeave={() => setHoveredButton(null)}
        className="rounded p-1.5 transition-colors"
        style={getButtonStyle('navigate')}
        title={t('notifications.row.viewInSession')}
      >
        <ArrowRight className="size-4" />
      </button>
    </>
  );
};
