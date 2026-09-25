import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./OpenCodeDeliveryWarning', () => ({
  OpenCodeDeliveryWarning: ({
    warning,
    debugDetails,
  }: {
    warning: string;
    debugDetails?: { messageId: string };
  }) => (
    <span data-runtime-warning="true">
      {warning} {debugDetails?.messageId}
    </span>
  ),
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

  it('shows the matching hard runtime diagnostics over a generic submission error', () => {
    const html = renderToStaticMarkup(
      <MessageComposerStatusNotice
        readError={null}
        persistenceStatus="memory-only"
        restoredDeliveryUnknown
        restrictionReason={null}
        submissionError="Delivery was not positively confirmed."
        sendWarning="OpenCode runtime delivery failed"
        sendDebugDetails={{
          messageId: 'send-1',
          providerId: 'opencode',
          delivered: false,
          responsePending: false,
          responseState: 'failed',
          ledgerStatus: 'failed',
          acceptanceUnknown: false,
          reason: 'provider_error',
          diagnostics: ['provider_error'],
          userVisibleState: 'error',
        }}
        deduplicated={false}
      />
    );
    expect(html).toContain('data-runtime-warning="true"');
    expect(html).toContain('OpenCode runtime delivery failed');
    expect(html).toContain('send-1');
    expect(html).not.toContain('Delivery was not positively confirmed.');
  });

  it('keeps a non-failure warning behind an unrelated submission error', () => {
    const html = renderToStaticMarkup(
      <MessageComposerStatusNotice
        readError={null}
        persistenceStatus="durable"
        restoredDeliveryUnknown={false}
        restrictionReason={null}
        submissionError="Draft is occupied"
        sendWarning="OpenCode is checking delivery"
        sendDebugDetails={{
          messageId: 'send-2',
          providerId: 'opencode',
          delivered: true,
          responsePending: true,
          responseState: 'pending',
          ledgerStatus: 'accepted',
          acceptanceUnknown: false,
          reason: null,
          diagnostics: [],
          userVisibleState: 'checking',
        }}
        deduplicated={false}
      />
    );
    expect(html).toContain('Draft is occupied');
    expect(html).not.toContain('data-runtime-warning');
  });
});
