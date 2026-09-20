import React, { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { useExpandedTeamChat } from '@renderer/components/team/messages/useExpandedTeamChat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Controller = ReturnType<typeof useExpandedTeamChat>;

function Harness({ onController }: { onController: (controller: Controller) => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useExpandedTeamChat({
    teamName: 'atlas-hq',
    messagesPanelMode: 'sidebar',
    isActive: true,
    graphOpen: false,
    editorOpen: false,
    contentRef,
  });

  useEffect(() => {
    onController(controller);
  });
  useEffect(() => {
    controller.onNativeOwnershipChange(true);
  }, [controller.onNativeOwnershipChange]);

  return (
    <div>
      <div ref={contentRef} data-testid="content" />
      <div ref={controller.setTarget} data-testid="target" />
    </div>
  );
}

describe('useExpandedTeamChat', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(HTMLElement.prototype, 'moveBefore', {
      configurable: true,
      value(this: HTMLElement, node: Node, child: Node | null) {
        this.insertBefore(node, child);
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as unknown as { moveBefore?: unknown }).moveBefore;
  });

  it('collapses expansion when the native sidebar loses ownership', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let controller: Controller | null = null;
    const getController = (): Controller => {
      if (!controller) throw new Error('controller was not captured');
      return controller;
    };

    await act(async () => {
      root.render(<Harness onController={(next) => (controller = next)} />);
    });
    expect(getController().host.available).toBe(true);

    await act(async () => getController().host.onExpandedChange(true));
    expect(getController().expanded).toBe(true);
    expect(host.querySelector('[data-testid="content"]')?.hasAttribute('inert')).toBe(true);

    await act(async () => getController().onNativeOwnershipChange(false));
    expect(getController().expanded).toBe(false);
    expect(host.querySelector('[data-testid="content"]')?.hasAttribute('inert')).toBe(false);

    await act(async () => root.unmount());
  });
});
