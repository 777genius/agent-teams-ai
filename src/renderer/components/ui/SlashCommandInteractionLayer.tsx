import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { calculateInlineMatchPositions } from '@renderer/utils/chipUtils';

import type {
  KnownSlashCommandDefinition,
  ParsedStandaloneSlashCommand,
} from '@shared/utils/slashCommands';

interface SlashCommandInteractionLayerProps {
  command: ParsedStandaloneSlashCommand;
  definition: KnownSlashCommandDefinition | null;
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  scrollTop: number;
}

export const SlashCommandInteractionLayer = ({
  command,
  definition,
  value,
  textareaRef,
  scrollTop,
}: SlashCommandInteractionLayerProps): React.JSX.Element | null => {
  const [position, setPosition] = React.useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const [match] = calculateInlineMatchPositions(textarea, value, [
      {
        item: command,
        start: command.startIndex,
        end: command.endIndex,
        token: command.raw,
      },
    ]);

    if (!match) {
      setPosition(null);
      return;
    }

    setPosition({
      top: match.top,
      left: match.left,
      width: match.width,
      height: match.height,
    });
  }, [command, textareaRef, value]);

  if (!definition || !position) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div style={{ transform: `translateY(-${scrollTop}px)` }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="pointer-events-auto absolute cursor-help"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                height: position.height,
              }}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1">
              <div className="text-xs font-medium text-amber-400">{definition.command}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {definition.description}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
