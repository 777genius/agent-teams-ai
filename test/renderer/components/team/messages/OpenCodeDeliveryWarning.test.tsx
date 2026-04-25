import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeDeliveryWarning } from '../../../../../src/renderer/components/team/messages/OpenCodeDeliveryWarning';

import type { OpenCodeRuntimeDeliveryDebugDetails } from '../../../../../src/renderer/utils/openCodeRuntimeDeliveryDiagnostics';

const warning =
  'OpenCode runtime delivery is still being checked. Message was saved and will be retried if needed.';

const debugDetails: OpenCodeRuntimeDeliveryDebugDetails = {
  messageId: 'm-opencode-1',
  providerId: 'opencode',
  delivered: true,
  responsePending: true,
  responseState: 'pending',
  ledgerStatus: 'accepted',
  acceptanceUnknown: false,
  reason: 'assistant_response_pending',
  diagnostics: ['assistant_response_pending'],
};

function renderWarning(props: Partial<React.ComponentProps<typeof OpenCodeDeliveryWarning>> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <OpenCodeDeliveryWarning warning={warning} debugDetails={debugDetails} {...props} />
    );
  });

  return { host, root };
}

function findButton(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('OpenCodeDeliveryWarning', () => {
  it('renders short warning first and hides raw diagnostics until details are opened', async () => {
    const { host, root } = renderWarning();

    expect(host.textContent).toContain(warning);
    expect(host.textContent).toContain('Details');
    expect(host.textContent).not.toContain('ledgerStatus');
    expect(host.textContent).not.toContain('assistant_response_pending');

    await act(async () => {
      findButton(host, 'Details').click();
    });

    expect(host.textContent).toContain('ledgerStatus');
    expect(host.textContent).toContain('accepted');
    expect(host.textContent).toContain('responseState');
    expect(host.textContent).toContain('pending');
    expect(host.textContent).toContain('reason');
    expect(host.textContent).toContain('assistant_response_pending');

    await act(async () => {
      root.unmount();
    });
  });

  it('copies stable debug details text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { host, root } = renderWarning();

    await act(async () => {
      findButton(host, 'Details').click();
    });
    await act(async () => {
      findButton(host, 'Copy debug details').click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"ledgerStatus": "accepted"'));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('"responseState": "pending"')
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('"reason": "assistant_response_pending"')
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('does not show details control without debug details', async () => {
    const { host, root } = renderWarning({ debugDetails: null });

    expect(host.textContent).toContain(warning);
    expect(host.textContent).not.toContain('Details');

    await act(async () => {
      root.unmount();
    });
  });

  it('hides details again when a different runtime delivery payload arrives', async () => {
    const { host, root } = renderWarning();

    await act(async () => {
      findButton(host, 'Details').click();
    });
    expect(host.textContent).toContain('ledgerStatus');

    await act(async () => {
      root.render(
        <OpenCodeDeliveryWarning
          warning={warning}
          debugDetails={{
            ...debugDetails,
            messageId: 'm-opencode-2',
            ledgerStatus: 'retry_scheduled',
            reason: 'retry_scheduled',
            diagnostics: ['retry_scheduled'],
          }}
        />
      );
    });

    expect(host.textContent).toContain(warning);
    expect(host.textContent).toContain('Details');
    expect(host.textContent).not.toContain('ledgerStatus');
    expect(host.textContent).not.toContain('retry_scheduled');

    await act(async () => {
      root.unmount();
    });
  });
});
