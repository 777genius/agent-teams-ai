import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => React.createElement('button', { type: 'button', onClick }, children),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

vi.mock('@renderer/components/team/CliLogsRichView', () => ({
  CliLogsRichView: ({ cliLogsTail }: { cliLogsTail: string }) =>
    React.createElement('div', null, `logs:${cliLogsTail}`),
}));

vi.mock('@renderer/components/team/StepProgressBar', () => ({
  StepProgressBar: () => React.createElement('div', null, 'step-progress'),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    CheckCircle2: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Info: Icon,
    Loader2: Icon,
    X: Icon,
  };
});

import { ProvisioningProgressBlock } from '@renderer/components/team/ProvisioningProgressBlock';

describe('ProvisioningProgressBlock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps live output and CLI logs collapsed by default while launch is still running', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 1,
          loading: true,
          startedAt: '2026-04-20T12:00:00.000Z',
          pid: 1234,
          assistantOutput: 'streamed output',
          cliLogsTail: 'tail line',
          defaultLiveOutputOpen: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Live output');
    expect(host.textContent).toContain('CLI logs');
    expect(host.textContent).not.toContain('streamed output');
    expect(host.textContent).not.toContain('logs:tail line');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
