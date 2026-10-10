import { useAppTranslation } from '@features/localization/renderer';
import { ComposerTextarea } from '@renderer/components/team/composer/ComposerSurface';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Mic, Send } from 'lucide-react';

import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';

interface MessageComposerInputProps extends Omit<
  ComponentPropsWithoutRef<typeof ComposerTextarea>,
  'cornerAction' | 'cornerActionInset' | 'onModEnter'
> {
  textareaRef?: Ref<HTMLTextAreaElement>;
  layout?: 'default' | 'compact';
  canSend: boolean;
  onSend: () => void;
  sendLabel?: string;
  sendUnavailableReason?: string;
  cornerActionPrefix?: ReactNode;
}

/** Shared editor and send controls for member and controlled text conversations. */
export const MessageComposerInput = ({
  textareaRef,
  layout = 'default',
  canSend,
  onSend,
  sendLabel,
  sendUnavailableReason,
  cornerActionPrefix,
  ...textareaProps
}: MessageComposerInputProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const hasText = textareaProps.value.trim().length > 0;
  const submit = (): void => {
    if (canSend) onSend();
  };
  return (
    <ComposerTextarea
      {...textareaProps}
      ref={textareaRef}
      onModEnter={submit}
      cornerActionInset={layout === 'compact' ? 'compact' : 'default'}
      cornerAction={
        <div className="flex items-center gap-2">
          {cornerActionPrefix}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text-secondary)]"
                onClick={() => void window.electronAPI.openExternal('https://voicetext.site')}
              >
                <Mic size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('messageComposer.actions.voiceToText')}</TooltipContent>
          </Tooltip>
          <span className="message-composer-send-slot" data-visible={hasText ? 'true' : 'false'}>
            {hasText ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <button
                      type="button"
                      className="message-composer-send-button inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={!canSend}
                      onClick={submit}
                    >
                      <Send size={14} />
                      {sendLabel ?? t('messageComposer.actions.send')}
                    </button>
                  </span>
                </TooltipTrigger>
                {sendUnavailableReason ? (
                  <TooltipContent side="top">{sendUnavailableReason}</TooltipContent>
                ) : null}
              </Tooltip>
            ) : null}
          </span>
        </div>
      }
    />
  );
};

/** Existing noncompact status, character count and saved indicator presentation. */
export const MessageComposerFooter = ({
  remaining,
  showSaved,
  children,
}: {
  remaining: number;
  showSaved: boolean;
  children?: ReactNode;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const showCharCount = remaining < 200;
  return (
    <div className="flex flex-col items-end gap-1">
      {children}
      {showCharCount || showSaved ? (
        <div className="flex items-center gap-2">
          {showCharCount ? (
            <span
              className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
            >
              {t('messageComposer.input.charsLeft', { count: remaining })}
            </span>
          ) : null}
          {showSaved ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t('tasks.createTask.saved')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
