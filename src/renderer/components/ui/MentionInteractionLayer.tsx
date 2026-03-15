/**
 * Interactive overlay layer for inline @mention badges.
 *
 * Positioned above the textarea (z-20), provides hover tooltips
 * showing the member/team name and role on mention spans.
 *
 * Uses the same mirror div technique (calculateMentionPositions)
 * as ChipInteractionLayer to position elements exactly over
 * the corresponding @mention tokens in the textarea.
 */

import * as React from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet, getThemedText } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { calculateMentionPositions } from '@renderer/utils/chipUtils';
import { nameColorSet } from '@renderer/utils/projectColor';
import { UsersRound } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { MentionPosition } from '@renderer/utils/chipUtils';

interface MentionInteractionLayerProps {
  suggestions: MentionSuggestion[];
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  scrollTop: number;
}

export const MentionInteractionLayer = ({
  suggestions,
  value,
  textareaRef,
  scrollTop,
}: MentionInteractionLayerProps): React.JSX.Element | null => {
  const [positions, setPositions] = React.useState<MentionPosition[]>([]);
  const { isLight } = useTheme();

  React.useLayoutEffect(() => {
    const filtered = suggestions.filter(
      (s) => s.type !== 'task' && s.type !== 'file' && s.type !== 'folder'
    );
    if (filtered.length === 0) {
      setPositions([]);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    setPositions(calculateMentionPositions(textarea, value, filtered));
  }, [suggestions, value, textareaRef]);

  if (positions.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div style={{ transform: `translateY(-${scrollTop}px)` }}>
        {positions.map((pos, idx) => {
          const isTeam = pos.suggestion.type === 'team';
          const colorSet = pos.suggestion.color
            ? getTeamColorSet(pos.suggestion.color)
            : isTeam
              ? nameColorSet(pos.suggestion.name, isLight)
              : null;

          return (
            <Tooltip key={`${pos.suggestion.id}-${idx}`}>
              <TooltipTrigger asChild>
                <div
                  className="pointer-events-auto absolute cursor-default"
                  style={{
                    top: pos.top,
                    left: pos.left,
                    width: pos.width,
                    height: pos.height,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <div className="flex items-center gap-2">
                  {isTeam ? (
                    <UsersRound
                      size={14}
                      className="shrink-0"
                      style={{
                        color: colorSet
                          ? getThemedText(colorSet, isLight)
                          : 'var(--color-text-muted)',
                      }}
                    />
                  ) : (
                    <MemberBadge
                      name={pos.suggestion.name}
                      color={pos.suggestion.color}
                      size="xs"
                      disableHoverCard
                    />
                  )}
                  <div className="min-w-0">
                    <div
                      className="text-xs font-medium"
                      style={colorSet ? { color: getThemedText(colorSet, isLight) } : undefined}
                    >
                      {pos.suggestion.name}
                    </div>
                    {pos.suggestion.subtitle ? (
                      <div className="text-[10px] text-[var(--color-text-muted)]">
                        {pos.suggestion.subtitle}
                      </div>
                    ) : null}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};
