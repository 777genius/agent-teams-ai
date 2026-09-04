import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import team from '@features/localization/renderer/locales/en/team.json';
import { WorkspaceTrustLaunchControl } from '@features/workspace-trust/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustDisplayStatus } from '@features/workspace-trust/renderer/hooks/useWorkspaceTrustStatus';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      key === 'launch.workspaceTrust.description' ? team.launch.workspaceTrust.description : key,
  }),
}));

const render = (status: WorkspaceTrustDisplayStatus) =>
  renderToStaticMarkup(
    createElement(WorkspaceTrustLaunchControl, {
      status,
      isLaunchMode: true,
      disabled: false,
      busy: false,
      submittingLabel: 'Launching',
      submitLabel: 'Launch',
      onClick: () => {},
    })
  );

describe('workspace trust notice and launch control', () => {
  it.each(['trusted', 'checking', 'disabled', 'not_applicable'] as const)(
    'hides notice for %s',
    (status) => {
      const html = render(status);
      expect(html).not.toContain('role="note"');
      expect(html).not.toContain('workspace-trust-launch-cta');
    }
  );

  it.each(['untrusted', 'unknown'] as const)(
    'renders one quiet safety sentence for %s without a card or CTA emphasis',
    (status) => {
      const html = render(status);
      expect(html).toMatch(
        /<p role="note"[^>]*>Project commands and MCP servers may run when the team starts\.<\/p>/
      );
      expect(html).not.toContain('launch.workspaceTrust.');
      expect(html).not.toContain('First launch');
      expect(html).not.toContain('Project trust');
      expect(html).not.toContain('border-amber');
      expect(html).not.toContain('workspace-trust-launch-cta');
    }
  );

  it('uses identical presentation for unknown and untrusted status', () => {
    expect(render('unknown')).toBe(render('untrusted'));
  });
});
