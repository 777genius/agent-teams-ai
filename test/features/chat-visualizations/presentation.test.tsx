import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, expect, it, vi } from 'vitest';

import {
  ChatVisualizationPresentationProvider,
  ChatVisualizationProvider,
} from '../../../src/features/chat-visualizations/renderer/composition';
import { VisualizationShell } from '../../../src/features/chat-visualizations/renderer/ui/VisualizationShell';
import { MessagesThreadPlacement } from '../../../src/renderer/components/team/messages/MessagesThreadPlacement';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@openuidev/react-ui', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const MermaidAdapter = () => null;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { moveBefore?: unknown }).moveBefore;
  document.body.innerHTML = '';
});

it('preserves the live thread and overrides opposite widths across Full Screen transitions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  let width = 1200;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, 100)
  );
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', {
    configurable: true,
    value(this: HTMLElement, node: Node, child: Node | null) {
      this.insertBefore(node, child);
    },
  });
  const host = document.createElement('div');
  const sidebar = document.createElement('div');
  const main = document.createElement('div');
  document.body.append(host, sidebar, main);
  const root = createRoot(host);
  const render = async (expanded: boolean) => {
    await act(async () =>
      root.render(
        <ChatVisualizationPresentationProvider presentation={expanded ? 'inline' : 'card'}>
          <MessagesThreadPlacement
            sidebarTarget={sidebar}
            expandedHost={{ target: main, available: true, expanded, onExpandedChange: vi.fn() }}
          >
            <input aria-label="Draft" defaultValue="unsent" />
            <ChatVisualizationProvider MermaidVisualization={MermaidAdapter}>
              <VisualizationShell kind="openui" status="content">
                <p>Report</p>
              </VisualizationShell>
            </ChatVisualizationProvider>
          </MessagesThreadPlacement>
        </ChatVisualizationPresentationProvider>
      )
    );
  };
  try {
    await render(false);
    const shell = sidebar.querySelector<HTMLElement>('[data-chat-visualization-kind]')!;
    const draft = sidebar.querySelector<HTMLInputElement>('input')!;
    draft.value = 'preserved draft';
    expect(shell.dataset.chatVisualizationPresentation).toBe('card');
    await act(async () => sidebar.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    width = 280;
    await render(true);
    expect(main.querySelector('[data-chat-visualization-kind]')).toBe(shell);
    expect(shell.dataset.chatVisualizationPresentation).toBe('inline');
    expect(main.textContent).toContain('Report');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(main.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('preserved draft');
    width = 1200;
    await render(false);
    expect(sidebar.querySelector('[data-chat-visualization-kind]')).toBe(shell);
    expect(shell.dataset.chatVisualizationPresentation).toBe('card');
    expect(sidebar.querySelector('button')?.textContent).toBe('Open visualization');
    expect(sidebar.querySelector('input')).toBe(draft);
  } finally {
    await act(async () => root.unmount());
  }
});

it('retains width-based presentation outside an explicit chat scope', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  let width = 900;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, 100)
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <VisualizationShell key="wide" kind="mermaid" status="content">
          <p>Diagram</p>
        </VisualizationShell>
      )
    );
    expect(
      host.querySelector<HTMLElement>('[data-chat-visualization-kind]')?.dataset
        .chatVisualizationPresentation
    ).toBe('inline');
    width = 280;
    await act(async () =>
      root.render(
        <VisualizationShell key="narrow" kind="mermaid" status="content">
          <p>Diagram</p>
        </VisualizationShell>
      )
    );
    expect(
      host.querySelector<HTMLElement>('[data-chat-visualization-kind]')?.dataset
        .chatVisualizationPresentation
    ).toBe('card');
  } finally {
    await act(async () => root.unmount());
  }
});
