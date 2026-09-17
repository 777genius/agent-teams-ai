import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ProcessesSection } from '@renderer/components/team/ProcessesSection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: (): null => null,
}));

const processRow = {
  id: 'proc-1',
  pid: 4242,
  label: 'dev-server',
  registeredAt: '2026-09-17T13:00:00.000Z',
};

describe('ProcessesSection', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not treat leftover live process rows as running after Stop', async () => {
    await act(async () => {
      root.render(
        <ProcessesSection
          teamName="mixed-v2150"
          members={[]}
          processes={[processRow]}
          isTeamAlive={false}
        />
      );
    });

    expect(host.textContent).toContain('dev-server');
    expect(host.textContent).not.toContain('processes.kill');
    expect(host.querySelector('.animate-ping')).toBeNull();
  });

  it('keeps kill available while the team is actually alive', async () => {
    await act(async () => {
      root.render(
        <ProcessesSection
          teamName="mixed-v2150"
          members={[]}
          processes={[processRow]}
          isTeamAlive={true}
        />
      );
    });

    expect(host.textContent).toContain('processes.kill');
    expect(host.querySelector('.animate-ping')).not.toBeNull();
  });
});
