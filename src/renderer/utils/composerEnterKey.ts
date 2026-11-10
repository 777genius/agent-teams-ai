import { isImeComposing } from './imeComposition';
import { IS_MAC } from './platformKeys';

import type React from 'react';

/** Called after mention selection so consumed Enter never queues or submits text. */
export function handleComposerEnterKey(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  onSend?: () => void,
  onQueue?: () => void,
  isMac = IS_MAC
): boolean {
  if (event.defaultPrevented || isImeComposing(event) || event.key !== 'Enter' || event.shiftKey) {
    return false;
  }
  const queueShortcut = !!onQueue && (isMac ? event.metaKey : event.ctrlKey);
  const callback = queueShortcut ? onQueue : onSend;
  if (!callback) return false;
  event.preventDefault();
  event.stopPropagation();
  // Holding the queue shortcut cannot enqueue another item or send the remaining draft.
  if (!queueShortcut || !event.repeat) callback();
  return true;
}
