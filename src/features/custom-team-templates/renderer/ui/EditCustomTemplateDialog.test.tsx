import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateTemplate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { updateTemplate } },
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

import { EditCustomTemplateDialog } from './EditCustomTemplateDialog';

import type {
  CustomTeamTemplateV1,
  UpdateCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  description: 'Ship it.',
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice', role: 'reviewer' }],
  revision: 5,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(
      <EditCustomTemplateDialog open template={template} onClose={onClose} onSaved={onSaved} />
    );
  });
}

function field(selector: string): HTMLInputElement | HTMLTextAreaElement {
  const found = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!found) throw new Error(`field not found: ${selector}\n${host.textContent}`);
  return found;
}

function setText(selector: string, value: string): void {
  const target = field(selector);
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function saveButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.edit.save')
  );
  if (!found) throw new Error(`save button not found\n${host.textContent}`);
  return found;
}

async function save(): Promise<void> {
  await act(async () => {
    saveButton().click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  updateTemplate.mockReset();
  updateTemplate.mockResolvedValue({
    status: 'updated',
    template: { ...template, revision: 6 },
  } satisfies UpdateCustomTeamTemplateResult);
  onClose = vi.fn();
  onSaved = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('EditCustomTemplateDialog', () => {
  it('saves the edited fields with the expected revision and closes on success', async () => {
    await render();
    await act(async () => {
      setText('#edit-template-name', 'Release Pipeline v2');
    });
    await save();

    expect(updateTemplate).toHaveBeenCalledWith({
      templateId: 'tmpl-1',
      expectedRevision: 5,
      fields: {
        name: 'Release Pipeline v2',
        description: 'Ship it.',
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer' }],
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog, the draft fields and the revision when the outcome is unresolved', async () => {
    updateTemplate.mockResolvedValue({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    } satisfies UpdateCustomTeamTemplateResult);

    await render();
    await act(async () => {
      setText('#edit-template-name', 'Unsaved draft');
      setText('#edit-template-prompt', 'Draft prompt.');
    });
    await save();

    const alert = host.querySelector('[data-testid="edit-template-unresolved"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedTitle');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedMutationBody');

    // Never a false success, never a generic storage failure, never a close.
    expect(host.querySelector('[data-testid="edit-template-saved"]')).toBeNull();
    expect(host.querySelector('[data-testid="edit-template-storage-unavailable"]')).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The user's unsaved edits survive so they can be recovered or retried.
    expect(field('#edit-template-name').value).toBe('Unsaved draft');
    expect(field('#edit-template-prompt').value).toBe('Draft prompt.');
    expect(updateTemplate).toHaveBeenCalledTimes(1);

    await save();
    expect(updateTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ templateId: 'tmpl-1', expectedRevision: 5 })
    );
  });

  it('shows visible feedback when the stored record cannot be read', async () => {
    updateTemplate.mockResolvedValue({
      status: 'unreadableRecord',
      templateId: 'tmpl-1',
    } satisfies UpdateCustomTeamTemplateResult);

    await render();
    await save();

    const alert = host.querySelector('[data-testid="edit-template-unreadable"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('customTemplates.errors.unreadableRecord');
    expect(host.querySelector('[data-testid="edit-template-unresolved"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a definite storage failure distinct from an unknown outcome', async () => {
    updateTemplate.mockResolvedValue({
      status: 'storageUnavailable',
    } satisfies UpdateCustomTeamTemplateResult);

    await render();
    await save();

    expect(host.querySelector('[data-testid="edit-template-storage-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="edit-template-unresolved"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
