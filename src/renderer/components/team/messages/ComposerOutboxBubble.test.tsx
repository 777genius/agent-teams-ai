import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { confirm } from '@renderer/components/common/ConfirmDialog';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposerOutboxBubble } from './ComposerOutboxBubble';

import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';

vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: vi.fn() }));

function item(status: ComposerOutboxItem['status']): ComposerOutboxItem {
  return {
    id: `item-${status}`,
    source: { kind: 'recovery', recoveryId: `recovery-${status}` },
    address: null,
    status,
    createdAt: 1,
    updatedAt: 2,
    displayText: '**Important** body',
    attachments: [],
    attachmentCount: 0,
    chipCount: 0,
    duplicateRisk: status === 'delivery-unknown',
    persistenceStatus: 'durable',
  };
}

type BubbleActions = Pick<
  React.ComponentProps<typeof ComposerOutboxBubble>,
  'onCopy' | 'onRestore' | 'onDiscard'
>;

async function renderBubble(
  status: ComposerOutboxItem['status'],
  actions: Partial<BubbleActions> = {}
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ComposerOutboxBubble
          item={item(status)}
          appearance="wide-chat"
          onCopy={actions.onCopy ?? vi.fn()}
          onRestore={actions.onRestore ?? vi.fn()}
          onDiscard={actions.onDiscard ?? vi.fn()}
        />
      </TooltipProvider>
    );
    await Promise.resolve();
  });
  return { host, root };
}

describe('ComposerOutboxBubble', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(confirm).mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps active sends non-destructive and exposes only copy', async () => {
    const { host, root } = await renderBubble('sending');
    expect(host.textContent).toContain('Sending...');
    expect(host.querySelector('strong')?.textContent).toBe('Important');
    expect(host.querySelector('button[aria-label="Copy text"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Delete"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Restore to draft"]')).toBeNull();
    act(() => root.unmount());
  });

  it('offers Edit, Copy and Delete for a definitive failure', async () => {
    const { host, root } = await renderBubble('not-sent');
    expect(host.textContent).toContain('Not sent');
    expect(host.querySelector('button[aria-label="Edit"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Copy text"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Delete"]')).not.toBeNull();
    expect(host.querySelector('[data-composer-outbox-status="not-sent"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('shows rejected restore and copy actions in the bubble', async () => {
    const { host, root } = await renderBubble('not-sent', {
      onRestore: vi.fn().mockRejectedValue(new Error('Restore unavailable')),
      onCopy: vi.fn().mockRejectedValue(new Error('Clipboard unavailable')),
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Restore unavailable');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Copy text"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Copy failed');
    act(() => root.unmount());
  });

  it('shows a rejected discard action after confirmation', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    const { host, root } = await renderBubble('not-sent', {
      onDiscard: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The local copy could not be removed safely.'
    );
    act(() => root.unmount());
  });
});
