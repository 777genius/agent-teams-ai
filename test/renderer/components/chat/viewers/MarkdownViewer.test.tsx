import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@features/team-task-detail/renderer',
  () => import('@features/team-task-detail/renderer/context/TaskDetailFileLinkContext')
);

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
      selectedTeamName: 'team-a',
      teams: [],
      openTeamTab: vi.fn(),
      searchMatchItemIds: new Set<string>(),
      searchQuery: '',
      searchMatches: [],
      currentSearchIndex: -1,
    }),
}));

vi.mock('@renderer/components/team/TaskTooltip', () => ({
  TaskTooltip: ({
    children,
    taskId,
    teamName,
    contextId,
  }: {
    children: React.ReactNode;
    taskId: string;
    teamName?: string;
    contextId?: string;
  }) =>
    React.createElement(
      'span',
      {
        'data-task-tooltip-task': taskId,
        'data-task-tooltip-team': teamName,
        'data-task-tooltip-context': contextId,
      },
      children
    ),
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

import { TaskDetailFileLinkProvider } from '@features/team-task-detail/renderer';
import {
  CompactMarkdownPreview,
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

describe('MarkdownViewer legacy task origin', () => {
  it('updates a reused compact preview when only its origin team changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const colors = new Map<string, string>();
    const onTeamClick = vi.fn();
    const view = (team: string) => (
      <CompactMarkdownPreview
        content="[#1](task://same-id)"
        taskOriginTeamName={team}
        teamColorByName={colors}
        onTeamClick={onTeamClick}
      />
    );
    await act(async () => root.render(view('team-b')));
    expect(
      host.querySelector('[data-task-tooltip-task]')?.getAttribute('data-task-tooltip-team')
    ).toBe('team-b');
    await act(async () => root.render(view('team-a')));
    expect(
      host.querySelector('[data-task-tooltip-task]')?.getAttribute('data-task-tooltip-team')
    ).toBe('team-a');
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps a literal same-ID legacy reference in team B when team A is globally selected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TaskDetailFileLinkProvider
          contextId="captured-context"
          teamName="team-b"
          taskId="task-b"
          projectPath="/TEST/project-b"
          onOpenFile={vi.fn()}
        >
          <MarkdownViewer
            content="[#1](task://canonical-or-display-id) [foreign](task://canonical-c?team=team-c)"
            bare
          />
        </TaskDetailFileLinkProvider>
      );
      await Promise.resolve();
    });

    const tooltip = host.querySelector('[data-task-tooltip-task="canonical-or-display-id"]');
    expect(tooltip?.getAttribute('data-task-tooltip-team')).toBe('team-b');
    expect(tooltip?.getAttribute('data-task-tooltip-team')).not.toBe('team-a');
    expect(tooltip?.getAttribute('data-task-tooltip-context')).toBe('captured-context');
    expect(
      host
        .querySelector('[data-task-tooltip-task="canonical-c"]')
        ?.getAttribute('data-task-tooltip-team')
    ).toBe('team-c');

    await act(async () => root.unmount());
    host.remove();
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
    await act(async () =>
      root.render(<MarkdownViewer bare content={'```openui-lang\nroot = Stack(['} />)
    );
    const shell = host.querySelector('[data-chat-visualization-kind="openui"]');
    expect(shell).not.toBeNull();
    await act(async () =>
      root.render(
        <MarkdownViewer
          bare
          content={'```openui-lang\nroot = Stack([Card([TextContent("Result")])]);\n```'}
        />
      )
    );
    expect(host.querySelector('[data-chat-visualization-kind="openui"]')).toBe(shell);
    await act(async () => root.unmount());
    host.remove();
  });
  it('uses compact labels for OpenUI and Mermaid without mounting visualization renderers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <CompactMarkdownPreview
          content={
            'Comparison\n```openui-lang\nroot = Stack([Card([TextContent("secretDSL")])]);\n```\n```mermaid\ngraph TD; secretNode-->B;\n```'
          }
        />
      )
    );
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
