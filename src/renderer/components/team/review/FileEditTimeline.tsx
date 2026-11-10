import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';

import type { FileEditTimeline as FileEditTimelineType } from '@shared/types/review';

interface FileEditTimelineProps {
  timeline: FileEditTimelineType;
  onEventClick?: (snippetIndex: number) => void;
  activeSnippetIndex?: number;
}

export const FileEditTimeline = ({
  timeline,
  onEventClick,
  activeSnippetIndex,
}: FileEditTimelineProps) => {
  const { t } = useAppTranslation('team');

  if (timeline.events.length === 0) {
    return <div className="px-3 py-2 text-xs text-text-muted">{t('review.timeline.empty')}</div>;
  }

  return (
    <div className="space-y-0 px-3 py-2">
      {timeline.events.map((event, idx) => {
        const isActive = activeSnippetIndex === event.snippetIndex;
        const isLast = idx === timeline.events.length - 1;
        const time = formatTime(event.timestamp);

        return (
          <div key={`${event.toolUseId}-${idx}`} className="flex">
            {/* Timeline line + dot */}
            <div className="flex w-5 shrink-0 flex-col items-center">
              <div
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  isActive ? 'bg-blue-400' : 'bg-zinc-500'
                )}
              />
              {!isLast && <div className="w-px flex-1 bg-zinc-700" />}
            </div>

            {/* Content */}
            <button
              onClick={() => onEventClick?.(event.snippetIndex)}
              className={cn(
                'mb-1.5 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors',
                isActive
                  ? 'bg-blue-500/10 text-blue-300'
                  : 'text-text-secondary hover:bg-surface-raised hover:text-text'
              )}
            >
              <span className="shrink-0 font-mono text-[10px] text-text-muted">{time}</span>
              <span className="min-w-0 flex-1 truncate text-xs">{event.summary}</span>
              <span className="flex shrink-0 items-center gap-0.5 text-[10px]">
                {event.linesAdded > 0 && (
                  <span className="text-green-400">+{event.linesAdded}</span>
                )}
                {event.linesRemoved > 0 && (
                  <span className="text-red-400">-{event.linesRemoved}</span>
                )}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
};

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '??:??';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '??:??';
  }
}
