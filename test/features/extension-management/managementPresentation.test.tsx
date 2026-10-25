import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it, vi } from 'vitest';

import { ManagedExtensionsPanel } from '../../../src/features/extension-management/renderer/ui/ManagedExtensionsPanel';
import { ManagementOperationView } from '../../../src/features/extension-management/renderer/ui/ManagementOperationView';

import type { ManagementOperation } from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({ MarkdownViewer: () => null }));
vi.mock('@renderer/components/extensions/skills/SkillImportDialog', () => ({
  SkillImportDialog: () => null,
}));

function operation(state: ManagementOperation['state'], mutated?: boolean): ManagementOperation {
  return {
    operationId: 'op-a',
    requestId: 'request-a',
    planId: 'plan-a',
    contextId: 'capture-a',
    environmentId: 'env-a',
    action: 'sync',
    state,
    phase: 'done',
    completed: 0,
    total: 0,
    items: [],
    diagnostics: [],
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    ...(mutated === undefined
      ? {}
      : { result: { outcome: state, mutated, items: [], nextActions: [], message: '' } }),
  };
}
function model(available: boolean): ManagedExtensionsModel {
  const noChange = () => {};
  const request = async () => {};
  const entry = {
    id: 'catalog-a',
    source: 'catalog-a',
    name: 'Sample',
    description: 'Sample plugin',
    targets: ['claude'],
    available: true,
    kind: 'plugin' as const,
  };
  return {
    available: true,
    client: 'claude',
    setClient: noChange,
    context: {
      contextId: 'host-a',
      selection: { client: 'claude', scope: 'user' },
      label: 'Claude',
      session: {
        apiVersion: 1,
        engineVersion: 'test',
        contextId: 'engine-a',
        environmentId: 'env-a',
        scope: 'user',
        targets: [
          {
            id: 'claude',
            client: 'claude',
            scope: 'user',
            label: 'Claude',
            displayPath: '/fixture/profile',
            available,
            reason: 'Install the native Claude client.',
          },
        ],
        capabilities: [
          { action: 'install', supported: true },
          { action: 'install_skills', supported: true },
        ],
      },
    },
    catalog: { items: [entry], freshness: 'current', diagnostics: [] },
    catalogLoading: false,
    catalogError: null,
    environment: { contextId: 'engine-a', entries: [], diagnostics: [] },
    plan: null,
    setPlan: noChange,
    closeReview: request,
    attestExternalUninstall: request,
    canAttestExternalUninstall: false,
    reviewUncertain: false,
    operation: null,
    candidates: null,
    closeDiscovery: request,
    error: null,
    busy: false,
    isRunning: false,
    query: '',
    setQuery: noChange,
    preview: null,
    setPreview: noChange,
    previewSkill: request,
    entryDetail: null,
    setEntryDetail: noChange,
    showDetail: request,
    copyCandidates: null,
    setCopyCandidates: noChange,
    loadCopySources: request,
    previewCopy: async () => ({
      planId: 'copy-plan',
      targetSkillDir: '/fixture/copy',
      changes: [],
      warnings: [],
      summary: { created: 0, updated: 0, deleted: 0, binary: 0 },
    }),
    applyCopy: async () => null,
    closeCopyReview: request,
    restoreLocal: request,
    recover: request,
    prepare: async () => true,
    apply: request,
    discover: request,
    cancel: request,
    reload: request,
    items: [entry],
    installed: [],
  };
}
const renderPanel = (available: boolean) => {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    createElement(ManagedExtensionsPanel, { kind: 'plugin', model: model(available) })
  );
  return root;
};
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((item) => item.textContent === text)!;

describe('management recovery and availability UI', () => {
  it.each([
    ['partial', undefined],
    ['interrupted', undefined],
    ['failed', true],
    ['canceled', true],
  ] as const)('offers recovery for %s even without next actions', (state, mutated) => {
    const html = renderToStaticMarkup(
      createElement(ManagementOperationView, {
        operation: operation(state, mutated),
        busy: false,
        onCancel: () => {},
        onRecover: () => {},
      })
    );
    expect(html).toContain('uap.recover');
  });
  it('does not offer recovery after an operation is resolved or an unchanged failure', () => {
    for (const value of [
      operation('failed', false),
      { ...operation('partial', true), resolvedBy: 'repair-a' },
    ]) {
      const html = renderToStaticMarkup(
        createElement(ManagementOperationView, {
          operation: value,
          busy: false,
          onCancel: () => {},
          onRecover: () => {},
        })
      );
      expect(html).not.toContain('uap.recover');
    }
  });
  it('disables both source and catalog installation when the selected native target is unavailable', () => {
    const root = renderPanel(false);
    expect(root.textContent).toContain('Install the native Claude client.');
    expect(button(root, 'uap.fromSource').disabled).toBe(true);
    expect(button(root, 'uap.install').disabled).toBe(true);
  });
  it('enables supported installation when the selected native target is available', () => {
    const root = renderPanel(true);
    expect(button(root, 'uap.fromSource').disabled).toBe(false);
    expect(button(root, 'uap.install').disabled).toBe(false);
  });
  it('keeps a separate Skill revision without forwarding it into plugin installation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const value = model(true);
    value.discover = vi.fn(async () => {});
    value.prepare = vi.fn(async () => true);
    const enter = (selector: string, text: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    try {
      await act(async () => {
        root.render(createElement(ManagedExtensionsPanel, { kind: 'skill', model: value }));
      });
      await act(async () => button(container, 'uap.fromSource').click());
      await act(async () => enter('#uap-source-skill', 'https://github.com/owner/repository'));
      await act(async () => enter('#uap-ref-skill', 'feature/skills'));
      await act(async () => button(document.body, 'uap.findSkills').click());
      expect(value.discover).toHaveBeenCalledWith(
        'https://github.com/owner/repository',
        'feature/skills'
      );

      await act(async () => {
        root.render(createElement(ManagedExtensionsPanel, { kind: 'plugin', model: value }));
      });
      expect(document.querySelector('#uap-ref-plugin')).toBeNull();
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
        'uap.pluginSourceHelp'
      );
      expect(document.querySelector<HTMLInputElement>('#uap-source-plugin')!.placeholder).toBe(
        'owner/repository@v1.2.3'
      );
      const source = `owner/repository@${'a'.repeat(40)}`;
      await act(async () => enter('#uap-source-plugin', source));
      await act(async () => button(document.body, 'uap.reviewInstall').click());
      expect(value.prepare).toHaveBeenCalledExactlyOnceWith({ action: 'install', source });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
  it('keeps transitive dependencies visible but disables independent lifecycle actions', () => {
    const value = model(true);
    value.context!.session.capabilities.push(
      { action: 'update', supported: true },
      { action: 'repair', supported: true },
      { action: 'remove', supported: true }
    );
    value.installed = [
      {
        alias: 'shared-library',
        kind: 'plugin',
        source: 'publisher/shared-library',
        declared: false,
        updateStatus: 'current',
        bindings: [],
      },
    ];
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(
      createElement(ManagedExtensionsPanel, { kind: 'plugin', model: value })
    );
    const row = root.querySelector<HTMLElement>('[data-testid="uap-installed-entry"]')!;
    expect(row.textContent).toContain('uap.transitiveDependency');
    expect(row.querySelector<HTMLButtonElement>('[role="checkbox"]')!.disabled).toBe(true);
    for (const action of ['update', 'repair', 'remove']) {
      expect(button(row, `uap.${action}`).disabled).toBe(true);
    }
    expect(button(row, 'uap.copyLocal').disabled).toBe(false);
  });
});
