import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preparePreview = vi.hoisted(() => vi.fn());
const saveTemplate = vi.hoisted(() => vi.fn());
const recheckSave = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { preparePreview, saveTemplate, recheckSave, listTemplates } },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(';')}`
        : key,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false, isDark: true, resolvedTheme: 'dark', theme: 'dark' }),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (next: boolean) => void;
    children: React.ReactNode;
  }) =>
    open
      ? React.createElement(
          'div',
          null,
          React.createElement('button', {
            type: 'button',
            'data-testid': 'dismiss',
            onClick: () => onOpenChange?.(false),
          }),
          children
        )
      : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import { TEAM_TEMPLATES } from '@features/team-templates';

import { MyTemplatesDialog } from './MyTemplatesDialog';

import type {
  CustomTeamTemplateV1,
  ListCustomTeamTemplatesResult,
} from '@features/custom-team-templates/contracts';

const templates: readonly CustomTeamTemplateV1[] = [
  {
    templateId: 'template-1',
    name: 'Alpha',
    description: 'Reusable setup',
    schemaVersion: 1,
    teamPrompt: 'Lead the work.',
    members: [{ name: 'ann', role: 'Developer' }],
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  {
    templateId: 'template-2',
    name: 'Beta',
    schemaVersion: 1,
    teamPrompt: '',
    members: [],
  },
];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;

function render(open = true): Promise<void> {
  return act(async () => {
    root.render(<MyTemplatesDialog open={open} onClose={onClose} />);
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!found) throw new Error(`button not found: ${label}\n${host.textContent}`);
  return found;
}

function tabTrigger(label: string): HTMLElement {
  const found = Array.from(host.querySelectorAll('[role="tab"]')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!found) throw new Error(`tab not found: ${label}\n${host.textContent}`);
  return found as HTMLElement;
}

async function selectTab(label: string): Promise<void> {
  // Radix Tabs activates on mousedown (see RuntimeProviderManagementPanelView tests).
  await act(async () => {
    tabTrigger(label).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
}

function activeTabLabel(): string | null {
  const active = host.querySelector('[role="tab"][aria-selected="true"]');
  return active?.textContent ?? null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preparePreview.mockReset();
  saveTemplate.mockReset();
  recheckSave.mockReset();
  listTemplates.mockReset();
  listTemplates.mockResolvedValue({ status: 'ready', templates });
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('MyTemplatesDialog', () => {
  it('renders the stored templates read-only', async () => {
    await render();
    expect(listTemplates).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="custom-template-library"]')).not.toBeNull();
    expect(host.textContent).toContain('Alpha');
    expect(host.textContent).toContain('Reusable setup');
    expect(host.textContent).toContain('customTemplates.library.memberNames|names=ann');
    expect(host.textContent).toContain('Beta');
    expect(host.textContent).toContain('customTemplates.library.noDescription');
    expect(host.textContent).toContain('customTemplates.library.noMembers');
    expect(host.textContent).toContain('customTemplates.library.createdAt|date=');

    const labels = Array.from(host.querySelectorAll('button')).map(
      (candidate) => candidate.textContent?.trim() ?? ''
    );
    // Read-only in A1: close (and retry on failures) are the only actions.
    expect(labels).toContain('actions.close');
    expect(labels.some((label) => /edit|delete|duplicate|export|import|create/i.test(label))).toBe(
      false
    );
  });

  it('uses the unified Templates dialog title without the technical description', async () => {
    await render();
    expect(host.textContent).toContain('customTemplates.library.title');
    expect(host.textContent).not.toContain('Read-only list');
    expect(host.textContent).toContain('customTemplates.library.description');
  });

  it('renders both Built-in and My Templates tabs with My Templates selected by default', async () => {
    await render();
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs).toHaveLength(2);
    expect(host.textContent).toContain('customTemplates.library.tabs.builtIn');
    expect(host.textContent).toContain('customTemplates.library.tabs.myTemplates');
    expect(activeTabLabel()).toContain('customTemplates.library.tabs.myTemplates');
  });

  it('switching to Built-in renders the existing built-in catalogue', async () => {
    await render();
    await selectTab('customTemplates.library.tabs.builtIn');
    expect(activeTabLabel()).toContain('customTemplates.library.tabs.builtIn');
    const catalogue = host.querySelector('[data-testid="built-in-template-catalogue"]');
    expect(catalogue).not.toBeNull();
    const references = Array.from(
      catalogue?.querySelectorAll('[data-template-reference]') ?? []
    ).map((entry) => entry.getAttribute('data-template-reference'));
    expect(references).toEqual(TEAM_TEMPLATES.map((template) => template.id));
    // Established expandable presentation: localized names, descriptions,
    // member roles and responsibility details (participant rows expand on demand).
    expect(catalogue?.textContent).toContain('templates.names.software-product');
    expect(catalogue?.textContent).toContain('templates.descriptions.software-product');
    const firstCard = catalogue?.querySelector('[data-template-reference="software-product"]');
    expect(firstCard).not.toBeNull();
    await act(async () => {
      (firstCard?.querySelector('button') as HTMLButtonElement | null)?.click();
      await Promise.resolve();
    });
    const expandedCard = host.querySelector('[data-template-reference="software-product"]');
    expect(expandedCard?.textContent).toContain('externalPrompt.responsibilities');
  });

  it('keeps built-ins usable when custom-template loading fails', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(
      host.querySelector('[data-testid="custom-template-library-error"]')?.textContent
    ).toContain('customTemplates.library.loadFailed');

    const builtInTab = tabTrigger('customTemplates.library.tabs.builtIn');
    expect(builtInTab.getAttribute('disabled')).toBeNull();
    expect(builtInTab.getAttribute('aria-disabled')).not.toBe('true');

    await selectTab('customTemplates.library.tabs.builtIn');
    expect(host.querySelector('[data-testid="built-in-template-catalogue"]')).not.toBeNull();
    // The failure stays scoped to My Templates and does not leak into Built-in.
    expect(
      host.querySelector('[data-testid="built-in-template-catalogue"]')?.textContent
    ).not.toContain('customTemplates.library.loadFailed');
  });

  it('keeps the failure visible and recoverable in My Templates', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline'));
    await render();
    // Retry is offered while the failing My Templates tab is active.
    expect(button('customTemplates.actions.retry')).not.toBeNull();

    // Switching away and back keeps the recoverable failure.
    await selectTab('customTemplates.library.tabs.builtIn');
    await selectTab('customTemplates.library.tabs.myTemplates');
    expect(
      host.querySelector('[data-testid="custom-template-library-error"]')?.textContent
    ).toContain('customTemplates.library.loadFailed');

    listTemplates.mockResolvedValue({ status: 'ready', templates });
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(host.querySelector('[data-testid="custom-template-library"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="custom-template-library-error"]')).toBeNull();
  });

  it('retrying custom templates does not reload the static built-in catalogue', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline'));
    await render();
    const callsBeforeRetry = listTemplates.mock.calls.length;
    listTemplates.mockResolvedValue({ status: 'ready', templates });
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    // Exactly one additional custom-template read; built-ins render statically.
    expect(listTemplates.mock.calls.length).toBe(callsBeforeRetry + 1);
    await selectTab('customTemplates.library.tabs.builtIn');
    expect(listTemplates.mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(host.querySelector('[data-testid="built-in-template-catalogue"]')).not.toBeNull();
  });

  it('ignores a late custom-template response after the dialog closes', async () => {
    let resolveList: (value: ListCustomTeamTemplatesResult) => void = () => undefined;
    listTemplates.mockImplementationOnce(
      () =>
        new Promise<ListCustomTeamTemplatesResult>((resolve) => {
          resolveList = resolve;
        })
    );
    await render();
    expect(host.textContent).toContain('customTemplates.library.loading');

    await selectTab('customTemplates.library.tabs.builtIn');
    // Close while the custom read is still in flight, then let it resolve late.
    await act(async () => {
      root.render(<MyTemplatesDialog open={false} onClose={onClose} />);
    });
    await act(async () => {
      resolveList({ status: 'ready', templates });
    });
    // Reopening re-reads instead of showing the stale late response as truth.
    await render(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listTemplates).toHaveBeenCalledTimes(2);
    await selectTab('customTemplates.library.tabs.myTemplates');
    expect(host.querySelector('[data-testid="custom-template-library"]')).not.toBeNull();
  });

  it('shows a genuinely empty library instead of an error', async () => {
    listTemplates.mockResolvedValue({ status: 'empty' } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.textContent).toContain('customTemplates.library.empty');
    expect(host.textContent).toContain('customTemplates.library.emptyDescription');
    expect(host.querySelector('[data-testid="custom-template-library"]')).toBeNull();
    expect(host.querySelector('[data-testid="custom-template-library-error"]')).toBeNull();
  });

  it('keeps unreadable stored records visible as a warning next to the readable ones', async () => {
    listTemplates.mockResolvedValue({
      status: 'hasUnreadableRecords',
      templates,
      unreadableRecords: [{ templateId: 'template-x', reason: 'unreadableRecord' }],
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.querySelector('[data-testid="custom-template-library"]')).not.toBeNull();
    expect(host.textContent).toContain('Alpha');
    expect(host.querySelector('[data-testid="custom-template-unreadable"]')?.textContent).toContain(
      'customTemplates.library.unreadableRecords|count=1'
    );
    expect(host.querySelector('[data-testid="custom-template-library-error"]')).toBeNull();
    expect(host.textContent).not.toContain('customTemplates.library.empty');
  });

  it('reports an unreachable storage distinctly with a Retry action', async () => {
    listTemplates.mockResolvedValue({
      status: 'storageUnavailable',
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(
      host.querySelector('[data-testid="custom-template-library-error"]')?.textContent
    ).toContain('customTemplates.library.storageUnavailable');
    expect(host.textContent).not.toContain('customTemplates.library.empty');

    listTemplates.mockResolvedValue({ status: 'ready', templates });
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(listTemplates).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="custom-template-library"]')).not.toBeNull();
  });

  it('recovers from a failed request instead of reporting an empty library', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(
      host.querySelector('[data-testid="custom-template-library-error"]')?.textContent
    ).toContain('customTemplates.library.loadFailed');
    expect(host.textContent).not.toContain('customTemplates.library.empty');

    listTemplates.mockResolvedValue({ status: 'ready', templates });
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(host.textContent).toContain('Alpha');
  });

  it('re-reads the library every time it opens', async () => {
    await render(false);
    expect(listTemplates).not.toHaveBeenCalled();
    await render(true);
    expect(listTemplates).toHaveBeenCalledTimes(1);
    await render(false);
    await render(true);
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it('exposes keyboard-operable tabs with tab roles and selection state', async () => {
    await render();
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-selected')).not.toBeNull();
      // Tab triggers remain keyboard-focusable controls.
      expect(tab.tagName.toLowerCase()).toBe('button');
      expect(tab.hasAttribute('disabled')).toBe(false);
    }
    const builtInTab = tabTrigger('customTemplates.library.tabs.builtIn') as HTMLButtonElement;
    builtInTab.focus();
    expect(document.activeElement).toBe(builtInTab);
    await act(async () => {
      builtInTab.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
    });
    // Selection state is always exposed, even if jsdom does not move Radix focus.
    expect(host.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull();
  });
});
