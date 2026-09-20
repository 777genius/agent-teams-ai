import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import {
  type ExpandedChatHost,
  MessagesThreadPlacement,
} from '@renderer/components/team/messages/MessagesThreadPlacement';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessagesThreadPlacement', () => {
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

  it('moves one live composer DOM node between connected slots without remounting', async () => {
    const rootNode = document.createElement('div');
    const sidebar = document.createElement('div');
    const main = document.createElement('div');
    document.body.append(rootNode, sidebar, main);
    const root = createRoot(rootNode);
    const mounts = vi.fn();
    const unmounts = vi.fn();

    function LiveComposer(): React.JSX.Element {
      useEffect(() => {
        mounts();
        return unmounts;
      }, []);
      return <textarea defaultValue="draft" data-testid="composer" />;
    }

    const render = async (expanded: boolean): Promise<void> => {
      const host: ExpandedChatHost = {
        target: main,
        available: true,
        expanded,
        onExpandedChange: vi.fn(),
      };
      await act(async () => {
        root.render(
          <MessagesThreadPlacement sidebarTarget={sidebar} expandedHost={host}>
            <LiveComposer />
          </MessagesThreadPlacement>
        );
      });
    };

    await render(false);
    const composer = sidebar.querySelector<HTMLTextAreaElement>('[data-testid="composer"]');
    expect(composer).not.toBeNull();
    composer!.value = 'unsent draft';

    await render(true);
    expect(main.querySelector('[data-testid="composer"]')).toBe(composer);
    expect(composer?.value).toBe('unsent draft');

    await render(false);
    expect(sidebar.querySelector('[data-testid="composer"]')).toBe(composer);
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(unmounts).toHaveBeenCalledTimes(1);
  });

  it('restores the live thread when both the expanded move and sidebar move fail', async () => {
    const rootNode = document.createElement('div');
    const sidebar = document.createElement('div');
    const main = document.createElement('div');
    document.body.append(rootNode, sidebar, main);
    const root = createRoot(rootNode);
    const onExpandedChange = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const render = async (expanded: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <MessagesThreadPlacement
            sidebarTarget={sidebar}
            expandedHost={{
              target: main,
              available: true,
              expanded,
              onExpandedChange,
            }}
          >
            <textarea defaultValue="draft" data-testid="composer" />
          </MessagesThreadPlacement>
        );
      });
    };

    await render(false);
    const composer = sidebar.querySelector<HTMLTextAreaElement>('[data-testid="composer"]');
    expect(composer).not.toBeNull();
    composer!.value = 'unsent draft';

    Object.defineProperty(main, 'moveBefore', {
      configurable: true,
      value(node: Node) {
        node.parentNode?.removeChild(node);
        throw new Error('expanded move failed');
      },
    });
    Object.defineProperty(sidebar, 'moveBefore', {
      configurable: true,
      value() {
        throw new Error('sidebar move failed');
      },
    });

    await render(true);

    expect(sidebar.querySelector('[data-testid="composer"]')).toBe(composer);
    expect(composer?.value).toBe('unsent draft');
    expect(onExpandedChange).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith(
      '[MessagesThreadPlacement] Failed to move live thread',
      expect.any(Error)
    );

    await act(async () => root.unmount());
    warn.mockRestore();
  });
});
