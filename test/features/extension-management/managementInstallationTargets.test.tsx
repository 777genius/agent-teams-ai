import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';
import { ManagedExtensionsPanel } from '../../../src/features/extension-management/renderer/ui/ManagedExtensionsPanel';

import type {
  ExtensionManagementAPI,
  ManagementSession,
} from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn<ExtensionManagementAPI['capture']>(),
  environment: vi.fn(async () => ({ contextId: 'engine-a', entries: [], diagnostics: [] })),
  catalog: vi.fn<ExtensionManagementAPI['catalog']>(),
  prepare: vi.fn<ExtensionManagementAPI['prepare']>(),
  apply: vi.fn<ExtensionManagementAPI['apply']>(),
  discardPlan: vi.fn(async () => {}),
  skillCopySources: vi.fn(async () => []),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(', ')}` : key,
  }),
  useLocaleFormatters: () => ({ dateTime: (value: string) => value }),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({ MarkdownViewer: () => null }));
vi.mock('@renderer/components/extensions/skills/SkillImportDialog', () => ({
  SkillImportDialog: () => null,
}));

const targets: ManagementSession['targets'] = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['cursor', 'Cursor'],
  ['grok', 'Grok'],
].map(([client, label]) => ({
  id: `profile-${client}`,
  client,
  label,
  scope: 'user',
  displayPath: `/fixture/${client}`,
  available: client !== 'grok',
  ...(client === 'grok' ? { reason: 'Install the native Grok client.' } : {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  backend.capture.mockImplementation(async (selection) => ({
    contextId: `host-${selection.client}`,
    selection,
    label: selection.client,
    session: {
      apiVersion: 1,
      engineVersion: 'test',
      contextId: 'engine-a',
      environmentId: 'shared-environment',
      scope: 'user',
      targets,
      capabilities: ['install', 'install_skills', 'remove', 'update', 'sync'].map((action) => ({
        action,
        supported: true,
      })),
    },
  }));
  backend.catalog.mockResolvedValue({
    items: [
      {
        id: 'catalog-a',
        name: 'Example plugin',
        description: 'Fixture plugin',
        kind: 'plugin',
        source: 'publisher/example',
        targets: ['claude', 'codex', 'opencode', 'cursor'],
        available: true,
      },
    ],
    freshness: 'current',
    diagnostics: [],
  });
  backend.prepare.mockImplementation(async ({ change }) => ({
    planId: 'plan-a',
    contextId: 'engine-a',
    action: change.action,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    confirmable: true,
    actions: (change.targetIds ?? []).map((targetId) => ({
      action: 'install',
      alias: 'example',
      targetId,
      description: 'Install the reviewed extension.',
    })),
    warnings: [],
    conflicts: [],
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function mount(panel = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current: ManagedExtensionsModel;
  function Harness() {
    current = useManagedExtensions('plugin');
    return panel ? <ManagedExtensionsPanel kind="plugin" model={current} /> : null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  return {
    host,
    model: () => current!,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const button = (host: ParentNode, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === text
  )!;
const targetCheckbox = (host: ParentNode, client: string) =>
  host.querySelector<HTMLButtonElement>(
    `[data-testid="uap-install-target"][data-target-id="profile-${client}"]`
  )!;

describe('installation targets', () => {
  it('names the Claude view option consistently with its captured native target', async () => {
    const scrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const view = await mount(true);
    try {
      const trigger = view.host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(
        [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)
      ).toEqual(['Claude Code', 'Codex', 'OpenCode']);
    } finally {
      await view.close();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it('defaults to the three available agent runtimes and sends one reviewed catalog request with their captured IDs', async () => {
    const view = await mount(true);
    try {
      for (const client of ['claude', 'codex', 'opencode']) {
        expect(targetCheckbox(view.host, client).getAttribute('aria-checked')).toBe('true');
      }
      expect(targetCheckbox(view.host, 'cursor').getAttribute('aria-checked')).toBe('false');
      expect(targetCheckbox(view.host, 'cursor').disabled).toBe(false);
      expect(targetCheckbox(view.host, 'grok').disabled).toBe(true);
      expect(view.host.textContent).toContain('Install the native Grok client.');
      await act(async () => button(view.host, 'uap.install').click());
      expect(backend.prepare).toHaveBeenCalledExactlyOnceWith({
        contextId: 'host-claude',
        catalogEntryId: 'catalog-a',
        change: {
          action: 'install',
          targetIds: ['profile-claude', 'profile-codex', 'profile-opencode'],
        },
      });
      const dialog = document.querySelector('[role="dialog"]')!;
      for (const label of ['Claude Code', 'Codex', 'OpenCode']) {
        expect(dialog.textContent).toContain(label);
      }
      expect(backend.apply).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  });

  it('preserves the install selection across view changes and keeps removal and copy scoped to the viewed profile', async () => {
    const view = await mount();
    try {
      await act(async () => {
        view.model().selectInstallationTarget('profile-codex', false);
        view.model().selectInstallationTarget('profile-cursor', true);
        view.model().setClient('opencode');
      });
      await act(async () => {
        await view.model().prepare({
          action: 'install_skills',
          catalogId: 'skills-a',
          candidateIds: ['candidate-a'],
        });
      });
      expect(backend.prepare.mock.calls[0][0]).toEqual({
        contextId: 'host-opencode',
        catalogEntryId: undefined,
        change: {
          action: 'install_skills',
          catalogId: 'skills-a',
          candidateIds: ['candidate-a'],
          targetIds: ['profile-claude', 'profile-opencode', 'profile-cursor'],
        },
      });
      await act(async () => {
        await view.model().prepare({ action: 'remove', aliases: ['example'] });
        await view.model().loadCopySources('example');
      });
      expect(backend.prepare.mock.calls[1][0].change).toEqual({
        action: 'remove',
        aliases: ['example'],
        targetIds: ['profile-opencode'],
      });
      expect(backend.skillCopySources).toHaveBeenCalledExactlyOnceWith({
        contextId: 'host-opencode',
        alias: 'example',
        targetId: 'profile-opencode',
      });
      await act(async () => {
        await view.model().prepare({ action: 'update', all: true });
      });
      expect(backend.prepare.mock.calls[2][0].change).toEqual({ action: 'update', all: true });
    } finally {
      await view.close();
    }
  });

  it('requires a nonempty selection without silently restoring defaults', async () => {
    const view = await mount(true);
    try {
      for (const client of ['claude', 'codex', 'opencode']) {
        await act(async () => targetCheckbox(view.host, client).click());
      }
      expect(button(view.host, 'uap.install').disabled).toBe(true);
      expect(button(view.host, 'uap.fromSource').disabled).toBe(true);
      await act(async () => {
        expect(await view.model().prepare({ action: 'install', source: 'publisher/example' })).toBe(
          false
        );
      });
      expect(backend.prepare).not.toHaveBeenCalled();
      expect(view.model().installationTargetIds).toEqual([]);
    } finally {
      await view.close();
    }
  });

  it('does not silently drop selected agents that a catalog plugin cannot support', async () => {
    const catalog = await backend.catalog({ contextId: 'fixture' });
    backend.catalog.mockResolvedValue({
      ...catalog,
      items: catalog.items.map((entry) => ({ ...entry, targets: ['claude'] })),
    });
    const view = await mount(true);
    try {
      expect(button(view.host, 'uap.install').disabled).toBe(true);
      expect(view.host.textContent).toContain('uap.incompatibleInstallTargets Codex, OpenCode');
      for (const client of ['codex', 'opencode']) {
        await act(async () => targetCheckbox(view.host, client).click());
      }
      expect(button(view.host, 'uap.install').disabled).toBe(false);
      await act(async () => button(view.host, 'uap.install').click());
      expect(backend.prepare.mock.calls[0][0].change.targetIds).toEqual(['profile-claude']);
    } finally {
      await view.close();
    }
  });

  it('re-prepares the reviewed target selection when native removal is explicitly attested', async () => {
    backend.prepare.mockResolvedValueOnce({
      planId: 'native-review',
      contextId: 'engine-a',
      action: 'install',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confirmable: false,
      actions: [],
      warnings: [],
      conflicts: [
        {
          code: 'EXTERNAL_UNINSTALL_REQUIRED',
          severity: 'error',
          message: 'Confirm native removal.',
        },
      ],
    });
    const view = await mount();
    try {
      await act(async () => {
        await view.model().prepare({ action: 'install', source: 'publisher/example' });
      });
      const original = backend.prepare.mock.calls[0][0];
      await act(async () => {
        view.model().selectInstallationTarget('profile-codex', false);
      });
      await act(async () => {
        await view.model().attestExternalUninstall();
      });
      expect(backend.prepare.mock.calls[1][0]).toEqual({
        ...original,
        change: { ...original.change, externalUninstalled: true },
      });
    } finally {
      await view.close();
    }
  });
});
