import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { ChevronDown, Clock } from 'lucide-react';

import { FileEditTimeline } from './FileEditTimeline';
import { ReviewFileTree } from './ReviewFileTree';

import type {
  ChangeReviewFileTreeDecisionState,
  ChangeReviewPathChangeLabels,
} from './ReviewFileTree';
import type {
  FileChangeSummary,
  FileEditTimeline as FileEditTimelineType,
} from '@shared/types/review';

export interface ChangeReviewSidebarProps {
  files: FileChangeSummary[];
  pathChangeLabels: ChangeReviewPathChangeLabels;
  decisionState: ChangeReviewFileTreeDecisionState;
  activeFilePath: string | null;
  viewedSet: Set<string>;
  onSelectFile: (filePath: string) => void;
  timeline: FileEditTimelineType | null;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  onTimelineEventClick: (snippetIndex: number) => void;
  activeSnippetIndex: number;
}

export const ChangeReviewSidebar = ({
  files,
  pathChangeLabels,
  decisionState,
  activeFilePath,
  viewedSet,
  onSelectFile,
  timeline,
  timelineOpen,
  onToggleTimeline,
  onTimelineEventClick,
  activeSnippetIndex,
}: ChangeReviewSidebarProps): React.ReactElement => {
  const { t } = useAppTranslation('team');

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-border bg-surface-sidebar">
      <ReviewFileTree
        files={files}
        pathChangeLabels={pathChangeLabels}
        decisionState={decisionState}
        selectedFilePath={null}
        onSelectFile={onSelectFile}
        viewedSet={viewedSet}
        activeFilePath={activeFilePath ?? undefined}
      />

      {/* Edit Timeline for active file */}
      {timeline && timeline.events.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={onToggleTimeline}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text"
          >
            <Clock className="size-3.5" />
            <span>
              {t('review.timeline.titleWithCount', {
                count: timeline.events.length,
              })}
            </span>
            <ChevronDown
              className={cn('ml-auto size-3 transition-transform', timelineOpen && 'rotate-180')}
            />
          </button>
          {timelineOpen && (
            <FileEditTimeline
              timeline={timeline}
              onEventClick={onTimelineEventClick}
              activeSnippetIndex={activeSnippetIndex}
            />
          )}
        </div>
      )}
    </div>
  );
};
