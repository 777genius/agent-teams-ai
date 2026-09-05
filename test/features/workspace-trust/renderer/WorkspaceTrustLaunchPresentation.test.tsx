import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import team from '@features/localization/renderer/locales/en/team.json';
import { WorkspaceTrustLaunchControl } from '@features/workspace-trust/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustDisplayStatus } from '@features/workspace-trust/renderer/hooks/useWorkspaceTrustStatus';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => {
      if (key === 'launch.workspaceTrust.title') return team.launch.workspaceTrust.title;
      if (key === 'launch.workspaceTrust.description') return team.launch.workspaceTrust.description;
      return key;
    },
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
  it.each(['trusted', 'checking', 'unknown', 'launch_scoped', 'disabled', 'not_applicable'] as const)(
    'hides notice for %s',
    (status) => {
      const html = render(status);
      expect(html).not.toContain('role="note"');
      expect(html).not.toContain('workspace-trust-launch-cta');
    }
  );

  it('renders a first-launch warning only for proven untrusted status', () => {
    const html = render('untrusted');
    expect(html).toContain('role="note"');
    expect(html).toContain('First launch will trust this project');
    expect(html).toContain('Project hooks and MCP servers may run when the team starts.');
    expect(html).not.toContain('launch.workspaceTrust.');
    expect(html).toContain('border-amber');
    expect(html).not.toContain('workspace-trust-launch-cta');
  });
});
