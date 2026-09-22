import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transformState = {
  items: [] as Array<{ type: 'ai'; group: Record<string, unknown> }>,
};

const enhanceState = {
  value: null as null | Record<string, unknown>,
};

vi.mock('@renderer/utils/groupTransformer', () => ({
  transformChunksToConversation: () => ({
    items: transformState.items,
  }),
}));

vi.mock('@renderer/utils/aiGroupEnhancer', () => ({
  enhanceAIGroup: (group: Record<string, unknown>) => ({
    ...group,
    ...(enhanceState.value ?? {}),
  }),
}));

vi.mock('@renderer/components/chat/LastOutputDisplay', () => ({
  LastOutputDisplay: ({ lastOutput }: { lastOutput: unknown }) => {
    if (!lastOutput) {
      return null;
    }
    return React.createElement(
      'div',
      { 'data-testid': 'last-output' },
      JSON.stringify(lastOutput)
    );
  },
}));

vi.mock('@renderer/components/chat/DisplayItemList', () => ({
  DisplayItemList: ({ items }: { items: Array<{ type: string }> }) =>
    React.createElement(
      'div',
      { 'data-testid': 'display-items' },
      items.map((item) => item.type).join(',')
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: () => null,
}));

import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function setSingleAiGroup(): void {
  transformState.items = [
    {
      type: 'ai',
      group: {
        id: 'group-1',
        steps: [],
        responses: [],
        processes: [],
      },
    },
  ];
}

describe('MemberExecutionLog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    transformState.items = [];
    enhanceState.value = null;
  });

  it('suppresses duplicated last tool_result banners when display items already cover the group', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSingleAiGroup();
    enhanceState.value = {
      displayItems: [
        {
          type: 'tool',
          id: 'tool-1',
          toolName: 'Read',
          timestamp: new Date('2026-04-18T13:23:11.000Z'),
        },
      ],
      itemsSummary: '1 tool',
      lastOutput: {
        type: 'tool_result',
        toolName: 'Read',
        toolResult: 'raw file body',
        isError: false,
        timestamp: new Date('2026-04-18T13:23:12.982Z'),
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(MemberExecutionLog, { chunks: [] }));
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="last-output"]')).toBeNull();
    expect(host.textContent).not.toContain('raw file body');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('keeps a lone tool_result visible so execution logs do not render blank', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSingleAiGroup();
    enhanceState.value = {
      displayItems: [],
      itemsSummary: 'No items',
      lastOutput: {
        type: 'tool_result',
        toolName: 'SendMessage',
        toolResult: 'deliveredToInbox: true',
        isError: false,
        timestamp: new Date('2026-04-18T13:23:12.982Z'),
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(MemberExecutionLog, { chunks: [] }));
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="last-output"]')).not.toBeNull();
    expect(host.textContent).toContain('SendMessage');
    expect(host.textContent).toContain('deliveredToInbox: true');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('keeps plain text last output visible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSingleAiGroup();
    enhanceState.value = {
      displayItems: [],
      itemsSummary: '1 output',
      lastOutput: {
        type: 'text',
        text: 'final answer',
        timestamp: new Date('2026-04-18T13:23:12.982Z'),
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(MemberExecutionLog, { chunks: [] }));
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="last-output"]')).not.toBeNull();
    expect(host.textContent).toContain('final answer');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('uses the member name for execution group labels when provided', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSingleAiGroup();
    enhanceState.value = {
      displayItems: [
        {
          type: 'tool',
          id: 'tool-1',
          toolName: 'read',
          timestamp: new Date('2026-04-18T13:23:11.000Z'),
        },
      ],
      itemsSummary: '1 tool call',
      lastOutput: null,
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(MemberExecutionLog, { chunks: [], memberName: 'jack' }));
      await flushMicrotasks();
    });

    expect(host.textContent ?? '').toMatch(/jack\s*turn/);
    expect(host.textContent).not.toContain('Agent turn');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
