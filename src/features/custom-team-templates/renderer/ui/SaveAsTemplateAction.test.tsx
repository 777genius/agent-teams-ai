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
      values ? `${key}|${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({
    children,
    closeDisabled: _closeDisabled,
    ...props
  }: {
    children: React.ReactNode;
    closeDisabled?: boolean;
    [key: string]: unknown;
  }) => React.createElement('div', { role: 'dialog', ...props }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import { TooltipProvider } from '@renderer/components/ui/tooltip';

import { setPendingTemplateMutation, getPendingTemplateMutations } from '../hooks/pendingTemplateMutation';
import { SaveAsTemplateAction } from './SaveAsTemplateAction';

const preview = {
  sourceTeamName: 'alpha',
  name: 'Alpha',
  teamPrompt: 'Lead the work.',
  members: [{ name: 'ann', role: 'Developer' }],
  warnings: [],
  canonicalContent: 'canonical',
  previewToken: 'token-1',
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onRowClick: ReturnType<typeof vi.fn>;

function renderAction(
  team: React.ComponentProps<typeof SaveAsTemplateAction>['team']
): Promise<void> {
  return act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <button type="button" onClick={onRowClick}>
          <SaveAsTemplateAction team={team} />
        </button>
      </TooltipProvider>
    );
  });
}

/** Resolves the lazy dialog chunk inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await import('./SaveAsTemplateDialog');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function actionButton(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('button[aria-label]');
  if (!found) throw new Error(`save action not found\n${host.textContent}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preparePreview.mockReset();
  saveTemplate.mockReset();
  recheckSave.mockReset();
  recheckSave.mockResolvedValue({ status: 'saved', template: {
    templateId: 'template-1', name: 'Alpha', schemaVersion: 1,
    teamPrompt: 'Lead the work.', members: [{ name: 'ann', role: 'Developer' }],
  } });
  listTemplates.mockReset();
  preparePreview.mockResolvedValue({ status: 'previewReady', preview });
  onRowClick = vi.fn();
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

describe('SaveAsTemplateAction', () => {
  it('renders an accessible action and prepares the preview when opened', async () => {
    await renderAction({ teamName: 'alpha', displayName: 'Alpha' });
    const button = actionButton();
    expect(button.getAttribute('aria-label')).toBe('customTemplates.actions.saveAsTemplate');
    expect(button.textContent).toBe('');

    await act(async () => {
      button.click();
    });
    await flush();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'alpha',
      name: 'Alpha',
      description: '',
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('can prepare a template from a configuration-only team before provisioning', async () => {
    await renderAction({ teamName: 'draft', displayName: 'Draft', pendingCreate: true });
    await act(async () => {
      actionButton().click();
    });
    await flush();
    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'draft',
      name: 'Draft',
      description: '',
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('reopens an unknown save with the original preview and safe re-check', async () => {
    saveTemplate.mockResolvedValue({ status: 'unresolvedWriteOutcome', templateId: 'template-1' });
    await renderAction({ teamName: 'alpha', displayName: 'Alpha' });
    await act(async () => actionButton().click());
    await flush();
    const find = (part: string): HTMLButtonElement => {
      const button = Array.from(host.querySelectorAll('button')).find((x) =>
        x.textContent?.includes(part)
      );
      if (!button) throw new Error('missing button: ' + part);
      return button;
    };
    await act(async () => find('customTemplates.actions.save').click());
    expect(getPendingTemplateMutations()).toHaveLength(1);
    expect(saveTemplate).toHaveBeenCalledTimes(1);

    await act(async () => find('actions.close').click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => actionButton().click());
    await flush();
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('customTemplates.states.unresolvedTitle');
    await act(async () => find('customTemplates.actions.recheck').click());
    expect(recheckSave).toHaveBeenCalledWith({ previewToken: 'token-1' });
    expect(getPendingTemplateMutations()).toHaveLength(0);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not prepare again on a parent re-render', async () => {
    await renderAction({ teamName: 'alpha', displayName: 'Alpha' });
    await act(async () => {
      actionButton().click();
    });
    await flush();
    expect(preparePreview).toHaveBeenCalledTimes(1);

    await renderAction({ teamName: 'alpha', displayName: 'Alpha' });
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
