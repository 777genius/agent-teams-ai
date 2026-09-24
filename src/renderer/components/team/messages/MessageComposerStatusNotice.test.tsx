import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./OpenCodeDeliveryWarning', () => ({
  OpenCodeDeliveryWarning: () => null,
}));

import { MessageComposerStatusNotice } from './MessageComposerStatusNotice';

describe('MessageComposerStatusNotice', () => {
  it('shows a failed send over sticky draft storage notices', () => {
    const html = renderToStaticMarkup(
      <MessageComposerStatusNotice
        readError={null}
        persistenceStatus="memory-only"
        restoredDeliveryUnknown
        restrictionReason={null}
        submissionError="Delivery failed"
        sendWarning={null}
        sendDebugDetails={null}
        deduplicated={false}
      />
    );
    expect(html).toContain('Delivery failed');
    expect(html).not.toContain('messageComposer.status.memoryOnly');
  });
});
