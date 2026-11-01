import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateTemplate = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { updateTemplate, listTemplates } },
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

/** Two members, so a member error can be shown not to leak onto its neighbour. */
const twoMembers: CustomTeamTemplateV1 = {
  ...template,
  members: [
    { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
    { name: 'bob', role: 'writer', workflow: 'Write the docs.' },
  ],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

function render(target: CustomTeamTemplateV1 = template): Promise<void> {
  return act(async () => {
    root.render(
      <EditCustomTemplateDialog open template={target} onClose={onClose} onSaved={onSaved} />
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

function recheckButton(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('[data-testid="edit-template-recheck"]');
  if (!found) throw new Error(`recheck button not found\n${host.textContent}`);
  return found;
}

async function save(): Promise<void> {
  await act(async () => {
    saveButton().click();
  });
}

async function recheck(): Promise<void> {
  await act(async () => {
    recheckButton().click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  updateTemplate.mockReset();
  listTemplates.mockReset();
  updateTemplate.mockResolvedValue({
    status: 'updated',
    template: { ...template, revision: 6 },
  } satisfies UpdateCustomTeamTemplateResult);
  listTemplates.mockResolvedValue({
    status: 'ready',
    templates: [{ ...template, revision: 6 }],
  });
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
  it.each([
    { memberField: 'workflow', newline: '\n' },
    { memberField: 'workflow', newline: '\r\n' },
    { memberField: 'role', newline: '\n' },
    { memberField: 'role', newline: '\r\n' },
  ] as const)(
    'preserves multiline $memberField through first edit and save (newline $newline)',
    async ({ memberField, newline }) => {
      await render({
        ...template,
        members: [
          {
            name: 'alice',
            role: 'reviewer',
            [memberField]: `Review change.${newline}Check risks.`,
          },
        ],
      });
      const selector = `#member-0-${memberField}`;
      const control = field(selector);
      // Browsers may normalize CRLF to LF; the two lines must remain distinct.
      expect(control.value.replace(/\r\n/g, '\n')).toBe('Review change.\nCheck risks.');
      await act(async () => {
        setText(selector, `${control.value}${newline}Document results.`);
      });
      expect(control.value.replace(/\r\n/g, '\n')).toBe(
        'Review change.\nCheck risks.\nDocument results.'
      );
      await save();
      expect(
        updateTemplate.mock.calls[0]?.[0].fields.members[0][memberField].replace(/\r\n/g, '\n')
      ).toBe('Review change.\nCheck risks.\nDocument results.');
    }
  );

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

    // The user's unsaved edits survive so they can be recovered or re-checked.
    expect(field('#edit-template-name').value).toBe('Unsaved draft');
    expect(field('#edit-template-prompt').value).toBe('Draft prompt.');
    expect(updateTemplate).toHaveBeenCalledTimes(1);

    // Save stays disabled: resending with the stale revision would race the
    // operation that may still be committing.
    expect(saveButton().disabled).toBe(true);
    await save();
    expect(updateTemplate).toHaveBeenCalledTimes(1);

    // A read-only re-check is the offered recovery route.
    expect(recheckButton().disabled).toBe(false);
    expect(recheckButton().textContent).toContain('customTemplates.actions.recheck');
  });

  it('confirms the update only when the re-check finds the exact next revision and content', async () => {
    updateTemplate.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    await render();
    await act(async () => {
      setText('#edit-template-name', 'Recovered name');
      setText('#edit-template-prompt', 'Recovered prompt.');
    });
    await save();

    expect(host.querySelector('[data-testid="edit-template-unresolved"]')).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The persisted row is still the old revision, which does not prove the
    // in-flight server operation failed. The outcome stays unknown.
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: [template] });
    await recheck();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="edit-template-unresolved"]')).not.toBeNull();

    // The exact intended content at expectedRevision + 1 proves the update.
    listTemplates.mockResolvedValueOnce({
      status: 'ready',
      templates: [
        {
          ...template,
          name: 'Recovered name',
          description: 'Ship it.',
          teamPrompt: 'Recovered prompt.',
          members: [{ name: 'alice', role: 'reviewer' }],
          revision: 6,
        },
      ],
    });
    await recheck();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="edit-template-saved"]')).not.toBeNull();
  });

  it('keeps the unknown outcome when the re-check cannot establish success', async () => {
    updateTemplate.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    await render();
    await act(async () => {
      setText('#edit-template-name', 'Still unsaved');
    });
    await save();

    listTemplates.mockResolvedValueOnce({ status: 'storageUnavailable' });
    await recheck();

    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="edit-template-unresolved"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="edit-template-saved"]')).toBeNull();
    expect(field('#edit-template-name').value).toBe('Still unsaved');
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

  it('describes simultaneous member errors separately for each field', async () => {
    updateTemplate.mockResolvedValue({
      status: 'validationFailed',
      issues: [
        { code: 'memberNameRequired', field: 'members[0].name' },
        { code: 'memberRoleTooLong', field: 'members[0].role' },
      ],
    } satisfies UpdateCustomTeamTemplateResult);
    await render(twoMembers);
    await save();
    const nameId = field('#member-0-name').getAttribute('aria-describedby');
    const roleId = field('#member-0-role').getAttribute('aria-describedby');
    expect(nameId).toBeTruthy();
    expect(roleId).toBeTruthy();
    expect(nameId).not.toBe(roleId);
    const nameError = document.getElementById(nameId!);
    const roleError = document.getElementById(roleId!);
    expect(nameError?.textContent).toContain('memberNameRequired');
    expect(nameError?.textContent).not.toContain('memberRoleTooLong');
    expect(roleError?.textContent).toContain('memberRoleTooLong');
    expect(roleError?.textContent).not.toContain('memberNameRequired');
  });

  it('marks only the member name input invalid and links it to that member error', async () => {
    updateTemplate.mockResolvedValue({
      status: 'validationFailed',
      issues: [{ code: 'memberNameRequired', field: 'members[0].name' }],
    } satisfies UpdateCustomTeamTemplateResult);

    await render(twoMembers);
    await save();

    const name = field('#member-0-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe('member-0-name-error');
    // A name issue never marks the sibling fields of the same member.
    expect(field('#member-0-role').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-0-role').hasAttribute('aria-describedby')).toBe(false);
    expect(field('#member-0-workflow').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-0-workflow').hasAttribute('aria-describedby')).toBe(false);
    // Nor any field of another member.
    expect(field('#member-1-name').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-1-name').hasAttribute('aria-describedby')).toBe(false);

    const error = host.querySelector('#member-0-name-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('customTemplates.errors.issues.memberNameRequired');
    expect(host.querySelector('#member-1-workflow-error')).toBeNull();
  });

  it('marks only the member role input invalid and links it to that member error', async () => {
    updateTemplate.mockResolvedValue({
      status: 'validationFailed',
      issues: [{ code: 'memberRoleTooLong', field: 'members[0].role' }],
    } satisfies UpdateCustomTeamTemplateResult);

    await render(twoMembers);
    await save();

    const role = field('#member-0-role');
    expect(role.getAttribute('aria-invalid')).toBe('true');
    expect(role.getAttribute('aria-describedby')).toBe('member-0-role-error');
    expect(field('#member-0-name').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-0-name').hasAttribute('aria-describedby')).toBe(false);
    expect(field('#member-0-workflow').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-1-role').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-1-role').hasAttribute('aria-describedby')).toBe(false);

    const error = host.querySelector('#member-0-role-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('customTemplates.errors.issues.memberRoleTooLong');
  });

  it('points a second member workflow error at its own member error element', async () => {
    updateTemplate.mockResolvedValue({
      status: 'validationFailed',
      issues: [{ code: 'memberWorkflowTooLong', field: 'members[1].workflow' }],
    } satisfies UpdateCustomTeamTemplateResult);

    await render(twoMembers);
    await save();

    const workflow = field('#member-1-workflow');
    expect(workflow.getAttribute('aria-invalid')).toBe('true');
    expect(workflow.getAttribute('aria-describedby')).toBe('member-1-workflow-error');
    expect(field('#member-1-name').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-1-role').hasAttribute('aria-invalid')).toBe(false);
    // The first member is neither marked invalid nor pointed at this error.
    expect(field('#member-0-workflow').hasAttribute('aria-invalid')).toBe(false);
    expect(field('#member-0-workflow').hasAttribute('aria-describedby')).toBe(false);

    const error = host.querySelector('#member-1-workflow-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('customTemplates.errors.issues.memberWorkflowTooLong');
    expect(host.querySelector('[id^="member-0-"][role="alert"]')).toBeNull();
    expect(document.getElementById(workflow.getAttribute('aria-describedby') ?? '')).toBe(error);
  });
});
