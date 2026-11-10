import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenUsageDisplay } from '../../../../src/renderer/components/common/TokenUsageDisplay';

import type { ContextStats } from '../../../../src/renderer/types/contextInjection';

const contextStats: ContextStats = {
  newInjections: [],
  accumulatedInjections: [
    {
      id: 'claude-md-1',
      category: 'claude-md',
      path: '/workspace/CLAUDE.md',
      source: 'project-local',
      displayName: 'CLAUDE.md',
      isGlobal: false,
      estimatedTokens: 200,
      firstSeenInGroup: 'ai-0',
    },
    {
      id: 'mentioned-file-1',
      category: 'mentioned-file',
      path: '/workspace/file.ts',
      displayName: 'file.ts',
      estimatedTokens: 300,
      firstSeenTurnIndex: 0,
      firstSeenInGroup: 'ai-0',
      exists: true,
    },
  ],
  totalEstimatedTokens: 500,
  tokensByCategory: {
    claudeMd: 200,
    mentionedFiles: 300,
    toolOutputs: 0,
    thinkingText: 0,
    taskCoordination: 0,
    userMessages: 0,
  },
  newCounts: {
    claudeMd: 0,
    mentionedFiles: 0,
    toolOutputs: 0,
    thinkingText: 0,
    taskCoordination: 0,
    userMessages: 0,
  },
};

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TokenUsageDisplay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps visible context scoped to prompt input instead of context window semantics', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TokenUsageDisplay, {
          inputTokens: 1000,
          cacheReadTokens: 500,
          cacheCreationTokens: 500,
          outputTokens: 250,
          contextStats,
        })
      );
      await flushReact();
    });

    const trigger = host.querySelector('[aria-haspopup="true"]');
    expect(trigger).toBeInstanceOf(HTMLElement);

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushReact();
    });

    const popover = document.querySelector('[role="tooltip"]');
    const expectedTotalTokens = new Intl.NumberFormat().format(2250);
    expect(popover).toBeTruthy();
    expect(popover?.textContent).toContain(expectedTotalTokens);
    expect(popover?.textContent).toContain('500 (25.0% of prompt input)');
    expect(popover?.textContent).not.toContain('of context');

    const visibleContextToggle = Array.from(document.querySelectorAll('[role="button"]')).find(
      (element) => element.textContent?.includes('Visible Context')
    );
    expect(visibleContextToggle).toBeTruthy();

    await act(async () => {
      visibleContextToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushReact();
    });

    expect(popover?.textContent).toContain('CLAUDE.md ×1');
    expect(popover?.textContent).toContain('(10.0%)');
    expect(popover?.textContent).toContain('@files ×1');
    expect(popover?.textContent).toContain('(15.0%)');

    await act(async () => {
      root.unmount();
      await flushReact();
    });
  });
});
