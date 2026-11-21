import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preparePreview = vi.hoisted(() => vi.fn());
const saveTemplate = vi.hoisted(() => vi.fn());
const recheckSave = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() => vi.fn());
const importTemplate = vi.hoisted(() => vi.fn());
const updateTemplate = vi.hoisted(() => vi.fn());
const duplicateTemplate = vi.hoisted(() => vi.fn());
const deleteTemplate = vi.hoisted(() => vi.fn());
const copyBuiltinTemplate = vi.hoisted(() => vi.fn());
const browserFile = vi.hoisted(() => ({ importFromFile: vi.fn(), exportToFile: vi.fn() }));
const desktopFile = vi.hoisted(() => ({ importFromFile: vi.fn(), exportToFile: vi.fn() }));

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    customTeamTemplates: {
      preparePreview,
      saveTemplate,
      recheckSave,
      listTemplates,
      importTemplate,
      updateTemplate,
      duplicateTemplate,
      deleteTemplate,
      copyBuiltinTemplate,
    },
  },
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
vi.mock('../hooks/useTemplateFileOperations', () => ({
  useTemplateFileOperations: vi.fn(() => ({
    platform: 'browser',
    desktopFile: undefined,
    browserFile,
  })),
}));
vi.mock('../hooks/useTemplateImport', () => ({
  useTemplateImport: vi.fn(() => ({ importTemplate })),
}));

import { TEAM_TEMPLATES } from '@features/team-templates';

import {
  getPendingTemplateMutations,
  resolveTemplateMutation,
  setPendingTemplateMutation,
} from '../hooks/pendingTemplateMutation';

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
  importTemplate.mockReset();
  updateTemplate.mockReset();
  duplicateTemplate.mockReset();
  deleteTemplate.mockReset();
  copyBuiltinTemplate.mockReset();
  browserFile.importFromFile.mockReset();
  browserFile.exportToFile.mockReset();
  desktopFile.importFromFile.mockReset();
  desktopFile.exportToFile.mockReset();
  listTemplates.mockResolvedValue({ status: 'ready', templates });
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  setPendingTemplateMutation(null);
  host.remove();
  vi.restoreAllMocks();
});

describe('MyTemplatesDialog', () => {
  it.each(
    (['duplicate', 'delete', 'copyBuiltin'] as const).flatMap((kind) =>
      (['unresolved', 'rejected'] as const).flatMap((outcome) =>
        (['before', 'after'] as const).map((order) => [kind, outcome, order] as const)
      )
    )
  )(
    'shows a decision from another window for %s %s (%s response)',
    async (kind, outcome, order) => {
      const mutation =
        kind === 'duplicate'
          ? duplicateTemplate
          : kind === 'delete'
            ? deleteTemplate
            : copyBuiltinTemplate;
      let resolveWrite!: (value: { status: 'unresolvedWriteOutcome'; templateId: string }) => void;
      let rejectWrite!: (error: Error) => void;
      mutation.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        })
      );
      await render();
      if (kind === 'copyBuiltin') {
        await selectTab('customTemplates.library.tabs.builtIn');
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="copy-builtin-open"]')?.click()
        );
      } else {
        await act(async () =>
          host
            .querySelector<HTMLButtonElement>(`[data-testid="${kind}-template-template-1"]`)
            ?.click()
        );
      }
      const action =
        kind === 'duplicate'
          ? 'customTemplates.duplicate.action'
          : kind === 'delete'
            ? 'customTemplates.delete.confirm'
            : 'customTemplates.copyBuiltin.action';
      await act(async () => button(action).click());
      const old = getPendingTemplateMutations()[0];
      const decideElsewhere = async () =>
        act(async () => {
          expect(resolveTemplateMutation(old)).toBe(true);
          setPendingTemplateMutation({ kind: 'edit', label: 'New action' });
        });
      const finish = async () =>
        act(async () => {
          if (outcome === 'unresolved')
            resolveWrite({ status: 'unresolvedWriteOutcome', templateId: 'x' });
          else rejectWrite(new Error('lost response'));
        });
      if (order === 'before') {
        await decideElsewhere();
        await finish();
      } else {
        await finish();
        await decideElsewhere();
      }
      const testId =
        kind === 'duplicate'
          ? 'duplicate-template-resolved-elsewhere'
          : kind === 'delete'
            ? 'delete-template-resolved-elsewhere'
            : 'copy-builtin-resolved-elsewhere';
      expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      expect(button(action).disabled).toBe(true);
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(getPendingTemplateMutations().map((item) => item.label)).toEqual(['New action']);
    }
  );
  it.each(['duplicate', 'delete', 'copyBuiltin'] as const)(
    're-reads the library and blocks another %s after an unknown outcome',
    async (operation) => {
      const mutation =
        operation === 'duplicate'
          ? duplicateTemplate
          : operation === 'delete'
            ? deleteTemplate
            : copyBuiltinTemplate;
      mutation.mockResolvedValueOnce({
        status: 'unresolvedWriteOutcome',
        templateId: 'unknown-id',
      });
      await render();
      if (operation === 'copyBuiltin') {
        await selectTab('customTemplates.library.tabs.builtIn');
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="copy-builtin-open"]')?.click()
        );
      } else {
        await act(async () =>
          host
            .querySelector<HTMLButtonElement>(`[data-testid="${operation}-template-template-1"]`)
            ?.click()
        );
      }
      const action =
        operation === 'duplicate'
          ? 'customTemplates.duplicate.action'
          : operation === 'delete'
            ? 'customTemplates.delete.confirm'
            : 'customTemplates.copyBuiltin.action';
      await act(async () => button(action).click());
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(button(action).disabled).toBe(true);
      await act(async () => button(action).click());
      expect(mutation).toHaveBeenCalledTimes(1);

      const updated = [
        ...templates,
        { ...templates[0], templateId: 'new-template', name: 'Fresh' },
      ];
      listTemplates.mockResolvedValueOnce({ status: 'ready', templates: updated });
      await act(async () => button('actions.cancel').click());
      expect(listTemplates).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
      if (operation === 'copyBuiltin') await selectTab('customTemplates.library.tabs.myTemplates');
      expect(host.textContent).toContain('Fresh');
      expect(
        host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
          ?.disabled
      ).toBe(true);
    }
  );

  it('keeps an unknown outcome after a read until the user explicitly accepts uncertainty', async () => {
    duplicateTemplate.mockResolvedValueOnce({ status: 'unresolvedWriteOutcome', templateId: '' });
    await render();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.click()
    );
    await act(async () => button('customTemplates.duplicate.action').click());
    await act(async () => button('actions.cancel').click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.disabled
    ).toBe(true);

    listTemplates.mockResolvedValueOnce({ status: 'storageUnavailable' });
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates });
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(host.textContent).toContain('customTemplates.states.snapshotWarning');
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.disabled
    ).toBe(true);
    expect(duplicateTemplate).toHaveBeenCalledTimes(1);
    await act(async () => button('customTemplates.actions.allowNewChanges').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.disabled
    ).toBe(false);
    expect(duplicateTemplate).toHaveBeenCalledTimes(1);
  });

  it('offers an explicit external-check decision for an incomplete library without retrying', async () => {
    duplicateTemplate.mockResolvedValueOnce({ status: 'unresolvedWriteOutcome', templateId: '' });
    await render();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.click()
    );
    await act(async () => button('customTemplates.duplicate.action').click());
    await act(async () => button('actions.cancel').click());
    listTemplates.mockResolvedValue({
      status: 'hasUnreadableRecords',
      templates,
      unreadableRecords: [{ templateId: 'broken', reason: 'unreadableRecord' }],
    });
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(host.textContent).toContain('customTemplates.states.partialSnapshotWarning');
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(duplicateTemplate).toHaveBeenCalledTimes(1);

    await act(async () => button('customTemplates.actions.keepChangesBlocked').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.disabled
    ).toBe(true);
    expect(host.textContent).not.toContain('customTemplates.actions.allowAfterExternalCheck');

    await act(async () => button('customTemplates.actions.recheck').click());
    await act(async () => button('customTemplates.actions.allowAfterExternalCheck').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).toBeNull();
    expect(duplicateTemplate).toHaveBeenCalledTimes(1);
  });

  it('shows every pending operation in this profile and keeps newer markers after a read', async () => {
    await render();
    await act(async () => {
      setPendingTemplateMutation({ kind: 'duplicate', label: 'First copy' });
      setPendingTemplateMutation({ kind: 'delete', label: 'Second item' });
    });
    expect(host.textContent).toContain('First copy');
    expect(host.textContent).toContain('Second item');
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(host.textContent).toContain('customTemplates.actions.allowNewChanges');
    await act(async () => {
      localStorage.setItem(
        'agent-teams:custom-template-pending-mutation:other-window',
        JSON.stringify({ kind: 'edit', label: 'Third item' })
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'agent-teams:custom-template-pending-mutation:other-window',
        })
      );
    });
    expect(host.textContent).toContain('Third item');
    expect(host.textContent).not.toContain('customTemplates.actions.allowNewChanges');
    await act(async () => button('customTemplates.actions.recheck').click());
    await act(async () => button('customTemplates.actions.allowNewChanges').click());
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).toBeNull();
  });

  it('keeps an unknown import blocked after its dialog closes', async () => {
    browserFile.importFromFile.mockResolvedValueOnce({
      status: 'unresolvedWriteOutcome',
      templateId: '',
    });
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="import-template-button"]')?.click()
    );
    const input = host.querySelector<HTMLInputElement>('#import-file-input')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['{}'], 'unknown.json')],
      configurable: true,
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(browserFile.importFromFile).toHaveBeenCalledTimes(1);
    const closeButtons = Array.from(host.querySelectorAll('button')).filter((item) =>
      item.textContent?.includes('actions.close')
    );
    await act(async () => closeButtons[closeButtons.length - 1].click());
    expect(host.textContent).toContain('unknown.json');
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="import-template-button"]')?.disabled
    ).toBe(true);
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
  });

  it('keeps an unknown edit blocked after its dialog closes', async () => {
    updateTemplate.mockResolvedValueOnce({
      status: 'unresolvedWriteOutcome',
      templateId: 'template-1',
    });
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="edit-template-template-1"]')?.click()
    );
    await act(async () => button('customTemplates.edit.save').click());
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    await act(async () => button('actions.cancel').click());
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="edit-template-template-1"]')?.disabled
    ).toBe(true);
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
  });

  it('blocks changes and explains when local recovery storage is unavailable', async () => {
    const realStorage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() {
        return realStorage.length;
      },
      key: realStorage.key.bind(realStorage),
      getItem: realStorage.getItem.bind(realStorage),
      removeItem: realStorage.removeItem.bind(realStorage),
      setItem: () => {
        throw new Error('storage denied');
      },
    });
    await render();
    expect(host.textContent).toContain('customTemplates.states.mutationStorageUnavailable');
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="duplicate-template-template-1"]')
        ?.disabled
    ).toBe(true);
    expect(duplicateTemplate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

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
    // A3: management actions are now available on each saved template card.
    expect(labels).toContain('actions.close');
    expect(labels.some((label) => /edit|delete|duplicate/i.test(label))).toBe(true);
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
    let resolveList!: (value: ListCustomTeamTemplatesResult) => void;
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

  it('warns about recovered storage and disables template imports', async () => {
    listTemplates.mockResolvedValue({
      status: 'recoveryRequired',
      storageDirectory: '/server/storage with spaces',
      markerPath: '/server/storage with spaces/app.db.templates-recovery-required',
      interruptedMarkerPath: '/server/storage with spaces/app.db.recovery-in-progress',
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.textContent).toContain('customTemplates.library.recoveryRequired');
    expect(host.querySelector('[data-testid="template-recovery-directory"]')?.textContent).toBe(
      '/server/storage with spaces'
    );
    expect(host.querySelector('[data-testid="template-recovery-marker"]')?.textContent).toBe(
      '/server/storage with spaces/app.db.templates-recovery-required'
    );
    expect(
      host.querySelector('[data-testid="template-recovery-interrupted-marker"]')?.textContent
    ).toBe('/server/storage with spaces/app.db.recovery-in-progress');
    expect(host.textContent).toContain('customTemplates.library.recoveryStopAndPreserve');
    expect(host.textContent).toContain('customTemplates.library.recoveryBackupWarning');
    expect(host.textContent).toContain('customTemplates.library.recoveryMarkerInstructions');
    expect(host.textContent).not.toContain('customTemplates.library.empty');
    const importButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="import-template-button"]'
    );
    expect(importButton === null || importButton.disabled).toBe(true);
  });

  it('warns when the recovery marker write could not be confirmed', async () => {
    listTemplates.mockResolvedValue({
      status: 'recoveryRequired',
      storageDirectory: '/server/storage',
      markerPath: '/server/storage/app.db.templates-recovery-required',
      interruptedMarkerPath: '/server/storage/app.db.recovery-in-progress',
      markerWriteFailed: true,
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.textContent).toContain('customTemplates.library.recoveryMarkerWriteFailed');
    expect(host.querySelector('[data-testid="template-recovery-directory"]')?.textContent).toBe(
      '/server/storage'
    );
    expect(host.textContent).not.toContain('customTemplates.library.empty');
    const importButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="import-template-button"]'
    );
    expect(importButton === null || importButton.disabled).toBe(true);
  });

  it('shows how to restore the worker when the existing database cannot be verified', async () => {
    listTemplates.mockResolvedValue({
      status: 'storageVerificationRequired',
      storageDirectory: '/server/storage',
      databasePath: '/server/storage/app.db',
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.textContent).toContain('customTemplates.library.storageVerificationRequired');
    expect(host.querySelector('[data-testid="template-unverified-database"]')?.textContent).toBe(
      '/server/storage/app.db'
    );
    expect(host.textContent).not.toContain('customTemplates.library.recoveryRequired');
    const importButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="import-template-button"]'
    );
    expect(importButton === null || importButton.disabled).toBe(true);
  });

  it('shows interrupted recovery instructions without claiming a rebuilt database', async () => {
    listTemplates.mockResolvedValue({
      status: 'recoveryInterrupted',
      storageDirectory: '/server/storage',
      markerPath: '/server/storage/app.db.templates-recovery-required',
      interruptedMarkerPath: '/server/storage/app.db.recovery-in-progress',
    } satisfies ListCustomTeamTemplatesResult);
    await render();
    expect(host.textContent).toContain('customTemplates.library.recoveryInterrupted');
    expect(host.textContent).not.toContain('customTemplates.library.recoveryRequired');
    expect(
      host.querySelector('[data-testid="template-recovery-interrupted-marker"]')?.textContent
    ).toBe('/server/storage/app.db.recovery-in-progress');
    expect(host.querySelector('[data-testid="template-recovery-marker"]')?.textContent).toBe(
      '/server/storage/app.db.templates-recovery-required'
    );
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

  describe('Import action availability', () => {
    it('shows Import action in empty library state', async () => {
      listTemplates.mockResolvedValue({ status: 'empty' });
      await render();
      expect(host.querySelector('[data-testid="import-template-button"]')).not.toBeNull();
    });

    it('shows Import action in ready library state', async () => {
      listTemplates.mockResolvedValue({ status: 'ready', templates });
      await render();
      expect(host.querySelector('[data-testid="import-template-button"]')).not.toBeNull();
    });

    it('shows Import action in partial library state', async () => {
      listTemplates.mockResolvedValue({
        status: 'hasUnreadableRecords',
        templates,
        unreadableRecords: [{ templateId: 'template-x', reason: 'unreadableRecord' }],
      });
      await render();
      expect(host.querySelector('[data-testid="import-template-button"]')).not.toBeNull();
    });

    it('does not place Import action in the Built-in tab', async () => {
      await render();
      await selectTab('customTemplates.library.tabs.builtIn');
      expect(host.querySelector('[data-testid="import-template-button"]')).toBeNull();
    });

    it('clicking Import opens the import dialog', async () => {
      listTemplates.mockResolvedValue({ status: 'empty' });
      await render();
      const importButton = host.querySelector<HTMLButtonElement>(
        '[data-testid="import-template-button"]'
      )!;
      expect(importButton).not.toBeNull();
      await act(async () => {
        importButton.click();
      });
      // Import dialog renders when importOpen is set
      expect(host.querySelector('[data-testid="import-template-done"]')).toBeNull();
      expect(host.textContent).toContain('customTemplates.import.title');
    });

    it('closing after successful import reloads the library', async () => {
      listTemplates.mockResolvedValue({ status: 'empty' });
      browserFile.importFromFile.mockResolvedValue({
        status: 'imported',
        template: {
          templateId: 'tmpl-new',
          name: 'New Template',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      });

      await render();
      const importButton = host.querySelector<HTMLButtonElement>(
        '[data-testid="import-template-button"]'
      )!;
      await act(async () => {
        importButton.click();
      });

      // Simulate import completion: the parent sets importOpen=false and calls reload
      // The import dialog's close button triggers onClose which calls reload
      const closeButtons = Array.from(host.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('actions.close')
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        closeButtons[closeButtons.length - 1].click();
      });
      expect(listTemplates).toHaveBeenCalledTimes(2); // initial + reload
    });

    it('shows the imported template after the first import into an empty library', async () => {
      const portableDocument = {
        format: 'agent-teams-custom-template',
        schemaVersion: 1,
        name: 'First Template',
        description: 'Imported from a file.',
        teamPrompt: 'Coordinate the work.',
        members: [{ name: 'ann', role: 'Developer' }],
      };
      listTemplates.mockResolvedValueOnce({ status: 'empty' }).mockResolvedValueOnce({
        status: 'ready',
        templates: [
          {
            templateId: 'tmpl-new',
            name: 'First Template',
            description: 'Imported from a file.',
            schemaVersion: 1,
            teamPrompt: 'Coordinate the work.',
            members: [{ name: 'ann', role: 'Developer' }],
            revision: 1,
          },
        ],
      });
      browserFile.importFromFile.mockResolvedValue({
        status: 'imported',
        template: {
          templateId: 'tmpl-new',
          name: 'First Template',
          description: 'Imported from a file.',
          schemaVersion: 1,
          teamPrompt: 'Coordinate the work.',
          members: [{ name: 'ann', role: 'Developer' }],
          revision: 1,
        },
      });

      await render();
      // The library starts empty and offers the import action.
      expect(host.textContent).toContain('customTemplates.library.empty');
      expect(host.textContent).not.toContain('First Template');

      await act(async () => {
        button('customTemplates.import.action').click();
      });
      const fileInput = host.querySelector<HTMLInputElement>('#import-file-input');
      expect(fileInput).not.toBeNull();
      Object.defineProperty(fileInput, 'files', {
        value: [
          new File([JSON.stringify(portableDocument)], 'template.json', {
            type: 'application/json',
          }),
        ],
        configurable: true,
      });
      await act(async () => {
        fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(browserFile.importFromFile).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();

      // Closing the import dialog makes the parent reload the library.
      const closeButtons = Array.from(host.querySelectorAll('button')).filter((candidate) =>
        candidate.textContent?.includes('actions.close')
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        closeButtons[closeButtons.length - 1].click();
      });

      expect(listTemplates).toHaveBeenCalledTimes(2);
      // The imported template is the visible library content, not just a refetch.
      const library = host.querySelector('[data-testid="custom-template-library"]');
      expect(library).not.toBeNull();
      expect(library?.textContent).toContain('First Template');
      expect(library?.textContent).toContain('Imported from a file.');
      expect(host.textContent).not.toContain('customTemplates.library.empty');
    });
  });

  describe('Export action availability', () => {
    it('does not add Export action to Built-in tab records', async () => {
      await render();
      await selectTab('customTemplates.library.tabs.builtIn');
      const exportButtons = Array.from(host.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('customTemplates.actions.export')
      );
      expect(exportButtons).toHaveLength(0);
    });

    it('keeps Copy Built-in workflow working', async () => {
      await render();
      await selectTab('customTemplates.library.tabs.builtIn');
      const copyButton = host.querySelector('[data-testid="copy-builtin-open"]');
      expect(copyButton).not.toBeNull();
    });
  });
});
