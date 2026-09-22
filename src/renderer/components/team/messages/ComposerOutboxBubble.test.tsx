import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposerOutboxBubble } from './ComposerOutboxBubble';

import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';

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

async function renderBubble(status: ComposerOutboxItem['status']) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ComposerOutboxBubble
          item={item(status)}
          appearance="wide-chat"
          onCopy={vi.fn()}
          onRestore={vi.fn()}
          onDiscard={vi.fn()}
        />
      </TooltipProvider>
    );
    await Promise.resolve();
  });
  return { host, root };
}

describe('ComposerOutboxBubble', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
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
});
