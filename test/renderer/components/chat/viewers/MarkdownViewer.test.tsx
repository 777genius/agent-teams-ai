import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(),
  },
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      teams: [],
      openTeamTab: vi.fn(),
      searchMatchItemIds: new Set<string>(),
      searchQuery: '',
      searchMatches: [],
      currentSearchIndex: -1,
    }),
}));

vi.mock('@renderer/components/team/TaskTooltip', () => ({
  TaskTooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/team/members/MemberHoverCard', () => ({
  MemberHoverCard: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/components/chat/viewers/FileLink', () => ({
  FileLink: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  isRelativeUrl: () => false,
}));

import {
  MarkdownViewer,
  CompactMarkdownPreview,
  resolveRelativePath,
} from '@renderer/components/chat/viewers/MarkdownViewer';

describe('MarkdownViewer code blocks', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders highlighted fenced code content instead of an empty copy-only block', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MarkdownViewer
          content={[
            'Содержимое файла `472/script.js`:',
            '',
            '```javascript',
            'const calculator = {',
            "    displayValue: '0',",
            '};',
            '',
            'function updateDisplay() {',
            "    const display = document.querySelector('.calculator-screen');",
            '    display.value = calculator.displayValue;',
            '}',
            '```',
          ].join('\n')}
          maxHeight="max-h-none"
          bare
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Содержимое файла');
    expect(host.textContent).toContain('const calculator');
    expect(host.textContent).toContain('function updateDisplay');
    expect(host.textContent).toContain('calculator.displayValue');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('MarkdownViewer local image path resolution', () => {
  it('resolves Windows relative image paths against a Windows base directory', () => {
    expect(resolveRelativePath('.\\images\\plot.png', 'C:\\Repo\\docs')).toBe(
      'C:\\Repo\\docs\\images\\plot.png'
    );
  });

  it('preserves absolute Windows image paths', () => {
    expect(resolveRelativePath('C:\\Screens\\plot.png', 'C:\\Repo\\docs')).toBe(
      'C:\\Screens\\plot.png'
    );
  });

  it('resolves Windows UNC parent image paths without escaping the share root', () => {
    expect(resolveRelativePath('..\\assets\\plot.png', '\\\\server\\share\\repo\\docs')).toBe(
      '\\\\server\\share\\repo\\assets\\plot.png'
    );
  });
});


describe('Markdown visualization integration', () => {
  it('preserves the shell DOM while an existing message grows', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<MarkdownViewer bare content={'```openui-lang\nroot = Stack(['} />));
    const shell = host.querySelector('[data-chat-visualization-kind="openui"]');
    expect(shell).not.toBeNull();
    await act(async () => root.render(<MarkdownViewer bare content={'```openui-lang\nroot = Stack([Card([TextContent("Result")])]);\n```'} />));
    expect(host.querySelector('[data-chat-visualization-kind="openui"]')).toBe(shell);
    await act(async () => root.unmount());
    host.remove();
  });
  it('uses compact labels for OpenUI and Mermaid without mounting visualization renderers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<CompactMarkdownPreview content={'Comparison\n```openui-lang\nroot = Stack([Card([TextContent("secretDSL")])]);\n```\n```mermaid\ngraph TD; secretNode-->B;\n```'} />));
    expect(host.textContent).toContain('Comparison');
    expect(host.textContent).toContain('Visualization');
    expect(host.textContent).toContain('Diagram');
    expect(host.textContent).not.toContain('secretDSL');
    expect(host.textContent).not.toContain('secretNode');
    expect(host.querySelector('[data-chat-visualization-kind]')).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });
});
