import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteTemplate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { deleteTemplate } },
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
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (next: boolean) => void;
    children: React.ReactNode;
  }) => (open ? React.createElement('div', null, children) : null),
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

import { DeleteCustomTemplateDialog } from './DeleteCustomTemplateDialog';

import type {
  CustomTeamTemplateV1,
  DeleteCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Ship.',
  members: [{ name: 'alice' }],
  revision: 4,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onDeleted: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(
      <DeleteCustomTemplateDialog
        open
        template={template}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    );
  });
}

function confirmButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.delete.confirm')
  );
  if (!found) throw new Error(`confirm button not found\n${host.textContent}`);
  return found;
}

async function confirmDelete(): Promise<void> {
  await act(async () => {
    confirmButton().click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  deleteTemplate.mockReset();
  deleteTemplate.mockResolvedValue({
    status: 'deleted',
    templateId: 'tmpl-1',
  } satisfies DeleteCustomTeamTemplateResult);
  onClose = vi.fn();
  onDeleted = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('DeleteCustomTemplateDialog', () => {
  it('closes and reports the deletion only when the delete is confirmed', async () => {
    await render();
    await confirmDelete();

    expect(deleteTemplate).toHaveBeenCalledWith({ templateId: 'tmpl-1', expectedRevision: 4 });
    expect(onDeleted).toHaveBeenCalledWith('tmpl-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps an unresolved delete open with delete-specific recovery wording', async () => {
    deleteTemplate.mockResolvedValue({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    } satisfies DeleteCustomTeamTemplateResult);

    await render();
    await confirmDelete();

    const alert = host.querySelector('[data-testid="delete-template-unresolved"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedTitle');
    // Delete-specific wording, never the save-specific unresolved message.
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedDeleteBody');
    expect(alert?.textContent).not.toContain('customTemplates.states.unresolvedBody');

    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteTemplate).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="delete-template-storage-unavailable"]')).toBeNull();
  });

  it('keeps a definite storage failure distinct from an unknown outcome', async () => {
    deleteTemplate.mockResolvedValue({
      status: 'storageUnavailable',
    } satisfies DeleteCustomTeamTemplateResult);

    await render();
    await confirmDelete();

    expect(
      host.querySelector('[data-testid="delete-template-storage-unavailable"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="delete-template-unresolved"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a revision conflict and refreshes the expected revision', async () => {
    deleteTemplate
      .mockResolvedValueOnce({
        status: 'revisionConflict',
        current: { ...template, revision: 7 },
      } satisfies DeleteCustomTeamTemplateResult)
      .mockResolvedValueOnce({
        status: 'deleted',
        templateId: 'tmpl-1',
      } satisfies DeleteCustomTeamTemplateResult);

    await render();
    await confirmDelete();
    expect(host.querySelector('[data-testid="delete-template-revision-conflict"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await confirmDelete();
    expect(deleteTemplate).toHaveBeenLastCalledWith({ templateId: 'tmpl-1', expectedRevision: 7 });
  });
});
