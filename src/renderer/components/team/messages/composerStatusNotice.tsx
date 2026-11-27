import { MessageComposerStatusNotice } from './MessageComposerStatusNotice';

import type { ComponentProps } from 'react';

/** Keep absent notices null so the composer does not reserve an empty footer. */
export function renderMessageComposerStatusNotice(
  props: ComponentProps<typeof MessageComposerStatusNotice>
) {
  const visible =
    props.readError ||
    props.persistenceStatus === 'memory-only' ||
    props.restoredDeliveryUnknown ||
    props.restrictionReason ||
    props.submissionError ||
    props.sendWarning ||
    props.deduplicated;
  return visible ? <MessageComposerStatusNotice {...props} /> : null;
}
