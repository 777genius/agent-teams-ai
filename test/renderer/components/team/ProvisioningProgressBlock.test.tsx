import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { type: 'button', onClick }, children),
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

  it('renders bounded launch diagnostics without opening CLI logs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 2,
          loading: true,
          defaultLiveOutputOpen: false,
          cliLogsTail: 'tail line',
          launchDiagnostics: [
            {
              id: 'bob:tmux_shell_only',
              memberName: 'bob',
              severity: 'warning',
              code: 'tmux_shell_only',
              label: 'bob - shell only',
              detail: 'tmux pane foreground command is zsh',
              observedAt: '2026-04-24T12:00:00.000Z',
            },
            {
              id: 'tom:runtime_not_found',
              memberName: 'tom',
              severity: 'warning',
              code: 'runtime_not_found',
              label: 'tom - no runtime found',
              detail: 'registered runtime metadata without live process',
              observedAt: '2026-04-24T12:00:01.000Z',
            },
            {
              id: 'jack:process_table_unavailable',
              memberName: 'jack',
              severity: 'warning',
              code: 'process_table_unavailable',
              label: 'jack - process table unavailable',
              detail: 'runtime pid could not be verified because process table is unavailable',
              observedAt: '2026-04-24T12:00:02.000Z',
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Diagnostics');
    expect(host.textContent).not.toContain('logs:tail line');

    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Diagnostics')
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('bob - shell only');
    expect(host.textContent).toContain('tmux pane foreground command is zsh');
    expect(host.textContent).toContain('tom - no runtime found');
    expect(host.textContent).toContain('registered runtime metadata without live process');
    expect(host.textContent).toContain('jack - process table unavailable');
    expect(host.textContent).toContain(
      'runtime pid could not be verified because process table is unavailable'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides launch diagnostics when all entries are informational', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 2,
          loading: true,
          defaultLiveOutputOpen: false,
          launchDiagnostics: [
            {
              id: 'alice:bootstrap_confirmed',
              memberName: 'alice',
              severity: 'info',
              code: 'bootstrap_confirmed',
              label: 'alice - bootstrap confirmed',
              observedAt: '2026-04-24T12:00:00.000Z',
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Diagnostics');
    expect(host.textContent).not.toContain('alice - bootstrap confirmed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
