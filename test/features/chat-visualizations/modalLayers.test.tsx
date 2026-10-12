import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { VisualizationShell } from '../../../src/features/chat-visualizations/renderer/ui/VisualizationShell';
import { ActivityMessageHoverCard } from '../../../src/renderer/components/team/activity/ActivityMessageHoverCard';
import { TooltipProvider } from '../../../src/renderer/components/ui/tooltip';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@openuidev/react-ui', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('visualization modal inside message hover card', () => {
  it.each(['compact', 'wide-chat'] as const)(
    'keeps %s hover toolbar out of the modal layer and closes on first Escape',
    async (appearance) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            <TooltipProvider>
              <ActivityMessageHoverCard
                copyText="report"
                showToolbar
                canRevise={false}
                appearance={appearance}
              >
                <div>
                  <VisualizationShell kind="openui" status="content">
                    <p>Report</p>
                  </VisualizationShell>
                </div>
              </ActivityMessageHoverCard>
            </TooltipProvider>
          )
        );
        const opener = Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent === 'Open visualization'
        )!;
        await act(async () => {
          opener.focus();
          opener.click();
        });
        // Radix schedules hover-open at120ms when the opener or portaled dialog receives focus.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
        });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.querySelector('[data-activity-message-toolbar]')).toBeNull();
        await act(async () =>
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(opener);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );
});
