import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { getAttachmentInputAcceptForMember } from '@renderer/utils/attachmentRecipientCapabilities';
import { Paperclip } from 'lucide-react';

import type { ResolvedTeamMember } from '@shared/types';
import type { ChangeEventHandler, RefObject } from 'react';

/** Original member attachment control, shared by the existing composer layouts. */
export const ComposerAttachmentButton = ({
  visible,
  enabled,
  member,
  reason,
  inputRef,
  onChange,
}: {
  visible: boolean;
  enabled: boolean;
  member: ResolvedTeamMember | undefined;
  reason: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex size-8 items-center justify-center">
      {visible ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={getAttachmentInputAcceptForMember(member)}
            multiple
            className="hidden"
            onChange={onChange}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
                  enabled
                    ? 'text-[var(--color-text-secondary)] hover:bg-white/[0.035] hover:text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] opacity-40'
                )}
                disabled={!enabled}
                onClick={() => inputRef.current?.click()}
              >
                <Paperclip size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {enabled
                ? t('messageComposer.attachments.attachFiles')
                : (reason ?? t('messageComposer.attachments.unavailable'))}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
};
