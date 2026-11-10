import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ReadToolViewer } from '@renderer/components/chat/items/linkedTool/ReadToolViewer';
import { CodeBlockViewer } from '@renderer/components/chat/viewers/CodeBlockViewer';

import type { LinkedToolItem } from '@renderer/types/groups';

async function renderViewer(
  element: React.ReactNode
): Promise<{ host: HTMLDivElement; root: Root }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });

  return { host, root };
}

async function unmountViewer(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
}

describe('tool code viewer defensive rendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders Read output when its tool input has no file path', async () => {
    const linkedTool: LinkedToolItem = {
      id: 'read-without-path',
      name: 'Read',
      input: {},
      result: {
        content: 'receipt total',
        isError: false,
      },
      inputPreview: '',
      startTime: new Date(),
      isOrphaned: false,
    };

    const { host, root } = await renderViewer(<ReadToolViewer linkedTool={linkedTool} />);

    expect(host.textContent).toContain('read-output');
    expect(host.textContent).toContain('receipt total');

    await unmountViewer(root);
  });

  it('does not crash on malformed runtime props', async () => {
    const { host, root } = await renderViewer(
      <CodeBlockViewer
        fileName={undefined as unknown as string}
        content={undefined as unknown as string}
      />
    );

    expect(host.textContent).toContain('code');
    expect(host.textContent).toContain('text');

    await unmountViewer(root);
  });
});
