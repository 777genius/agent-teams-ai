import type { TextMessageComposerProps } from './TextMessageComposer';
import type { ReactNode } from 'react';

export interface GroupComposerSnapshot {
  text: string;
  ready: boolean;
  hasCurrentSnapshot: boolean;
  pending: boolean;
  attemptId: string | null;
  error: string | null;
}

interface GroupComposerPresentationOptions {
  snapshot: GroupComposerSnapshot;
  label: string;
  ariaLabel: string;
  sendLabels: { send: string; sending: string; retry: string };
  freshSendAllowed: boolean;
  readOnly?: boolean;
  inputDisabled?: boolean;
  recipientSelector?: TextMessageComposerProps['recipientSelector'];
  notice?: ReactNode;
  onChange: (value: string) => void;
  onSend: () => void;
}

/** Controlled UI projection only; the hook owns draft and delivery lifecycle. */
export function getGroupComposerPresentation({
  snapshot,
  label,
  ariaLabel,
  sendLabels,
  freshSendAllowed,
  readOnly = false,
  inputDisabled = false,
  recipientSelector,
  notice,
  onChange,
  onSend,
}: GroupComposerPresentationOptions): Pick<
  TextMessageComposerProps,
  'textInput' | 'recipientSelector' | 'notice'
> {
  const current = snapshot.hasCurrentSnapshot;
  const locked = snapshot.pending || !!snapshot.attemptId;
  const editable = current && snapshot.ready && !locked && !readOnly && !inputDisabled;
  const canSend =
    current && snapshot.ready && !snapshot.pending && (!!snapshot.attemptId || freshSendAllowed);
  const selectorDisabled = !editable || !!recipientSelector?.disabled;
  return {
    recipientSelector:
      current && recipientSelector
        ? {
            ...recipientSelector,
            disabled: selectorDisabled,
            onSelect: (name) => {
              if (!selectorDisabled) recipientSelector.onSelect(name);
            },
          }
        : undefined,
    textInput: {
      label,
      ariaLabel,
      value: current ? snapshot.text : '',
      readOnly: !editable,
      disabled: !current || inputDisabled,
      canSend,
      sendLabel:
        current && snapshot.pending
          ? sendLabels.sending
          : current && snapshot.attemptId
            ? sendLabels.retry
            : sendLabels.send,
      onChange: (value) => {
        if (editable) onChange(value);
      },
      onSend: () => {
        if (canSend && !inputDisabled) onSend();
      },
    },
    notice: current ? (
      <>
        {notice}
        {snapshot.error ? (
          <p role="alert" className="text-xs text-red-400">
            {snapshot.error}
          </p>
        ) : null}
      </>
    ) : undefined,
  };
}
