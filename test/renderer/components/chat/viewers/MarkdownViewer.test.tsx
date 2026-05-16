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
