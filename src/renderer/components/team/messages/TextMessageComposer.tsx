import { ComposerSurface } from '@renderer/components/team/composer/ComposerSurface';
import { cn } from '@renderer/lib/utils';
import { MAX_TEXT_LENGTH } from '@shared/constants';

import { MessageComposerInput } from './MessageComposerInput';
import { useComposerTextarea } from './useComposerTextarea';
import { useFloatingComposerWidth } from './useFloatingComposerWidth';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ReactNode, Ref } from 'react';

const EMPTY_SUGGESTIONS: MentionSuggestion[] = [];

export interface TextMessageComposerProps {
  teamName: string;
  layout?: 'default' | 'compact';
  widthMode?: 'full' | 'floating-adaptive';
  textareaRef?: Ref<HTMLTextAreaElement>;
  suggestionPlacement?: 'above';
  autoFocusKey?: number;
  cornerActionPrefix?: ReactNode;
  notice?: ReactNode;
  textInput: {
    label: string;
    ariaLabel: string;
    value: string;
    readOnly: boolean;
    disabled: boolean;
    canSend: boolean;
    sendLabel: string;
    onChange: (value: string) => void;
    onSend: () => void;
  };
}

/** Controlled plain text mode; its conversation owns persistence and delivery. */
export const TextMessageComposer = ({
  teamName,
  layout = 'default',
  widthMode = 'full',
  textareaRef: externalTextareaRef,
  suggestionPlacement,
  autoFocusKey,
  cornerActionPrefix,
  notice,
  textInput,
}: TextMessageComposerProps): React.JSX.Element => {
  const { textareaRef, internalTextareaRef } = useComposerTextarea(
    externalTextareaRef,
    autoFocusKey
  );
  const floatingAdaptiveStyle = useFloatingComposerWidth({
    enabled: widthMode === 'floating-adaptive',
    text: textInput.value,
    attachmentCount: 0,
    textareaRef: internalTextareaRef,
  });
  return (
    <ComposerSurface
      className={cn(layout !== 'compact' && 'mb-2')}
      style={floatingAdaptiveStyle}
      role="group"
    >
      <div className="message-composer-flat-toolbar flex min-w-0 items-center justify-end px-3 text-xs">
        <span className="truncate text-[var(--color-text-secondary)]">{textInput.label}</span>
      </div>
      <MessageComposerInput
        textareaRef={textareaRef}
        connectedToHeader
        id={`compose-${teamName}`}
        aria-label={textInput.ariaLabel}
        placeholder={textInput.ariaLabel}
        suggestions={EMPTY_SUGGESTIONS}
        showHint={false}
        value={textInput.value}
        readOnly={textInput.readOnly}
        disabled={textInput.disabled}
        onValueChange={(value) => {
          if (!textInput.readOnly && !textInput.disabled) textInput.onChange(value);
        }}
        suggestionPlacement={suggestionPlacement}
        layout={layout}
        minRows={layout === 'compact' ? 1 : 2}
        maxRows={6}
        maxLength={MAX_TEXT_LENGTH}
        canSend={
          textInput.canSend &&
          !textInput.disabled &&
          textInput.value.trim().length > 0 &&
          textInput.value.trim().length <= MAX_TEXT_LENGTH
        }
        onSend={textInput.onSend}
        sendLabel={textInput.sendLabel}
        cornerActionPrefix={cornerActionPrefix}
        footerRight={notice}
      />
    </ComposerSurface>
  );
};
