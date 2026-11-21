import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import enTeam from '@features/localization/renderer/locales/en/team.json';
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
      key === 'customTemplates.states.pendingSaveHelp'
        ? enTeam.customTemplates.states.pendingSaveHelp
        : values
          ? `${key}|${Object.entries(values)
              .map(([name, value]) => `${name}=${String(value)}`)
              .join(';')}`
          : key,
  }),
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
  DialogContent: ({
    children,
    closeDisabled,
  }: {
    children: React.ReactNode;
    closeDisabled?: boolean;
  }) => React.createElement('div', { 'data-close-disabled': String(!!closeDisabled) }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import {
  getPendingTemplateMutations,
  resolveTemplateMutation,
  setPendingTemplateMutation,
} from '../hooks/pendingTemplateMutation';

import { SaveAsTemplateDialog } from './SaveAsTemplateDialog';

import type {
  ConfirmCustomTeamTemplateSaveResult,
  CustomTeamTemplatePreview,
  CustomTeamTemplateV1,
  PrepareCustomTeamTemplatePreviewResult,
  RecheckCustomTeamTemplateSaveResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'template-1',
  name: 'Alpha',
  schemaVersion: 1,
  teamPrompt: 'Lead the work.',
  members: [{ name: 'ann', role: 'Developer', workflow: 'code' }],
};

const preview: CustomTeamTemplatePreview = {
  sourceTeamName: 'alpha',
  name: 'Alpha',
  teamPrompt: 'Lead the work.',
  members: [{ name: 'ann', role: 'Developer', workflow: 'code' }, { name: 'bo' }],
  warnings: [
    { code: 'missingMemberRole', memberName: 'bo' },
    { code: 'missingMemberWorkflow', memberName: 'bo' },
  ],
  canonicalContent: 'canonical',
  previewToken: 'token-1',
};

const previewReady: PrepareCustomTeamTemplatePreviewResult = {
  status: 'previewReady',
  preview,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;

function render(
  overrides: Partial<React.ComponentProps<typeof SaveAsTemplateDialog>> = {}
): Promise<void> {
  return act(async () => {
    root.render(
      <SaveAsTemplateDialog
        open
        sourceTeamName="alpha"
        initialName="Alpha"
        onClose={onClose}
        {...overrides}
      />
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'));
}

function button(label: string): HTMLButtonElement {
  const found = buttons().find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}\n${host.textContent}`);
  return found;
}

function saveButton(): HTMLButtonElement {
  return button('customTemplates.actions.save');
}

function setText(selector: string, value: string): void {
  const field = host.querySelector(selector);
  if (!field) throw new Error(`field not found: ${selector}`);
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Drives Save to a state where the outcome is not yet confirmed. */
async function saveUntilUnresolved(): Promise<void> {
  saveTemplate.mockResolvedValueOnce({
    status: 'unresolvedWriteOutcome',
    templateId: 'template-1',
  } satisfies ConfirmCustomTeamTemplateSaveResult);
  await act(async () => {
    saveButton().click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preparePreview.mockReset();
  saveTemplate.mockReset();
  recheckSave.mockReset();
  listTemplates.mockReset();
  preparePreview.mockResolvedValue(previewReady);
  saveTemplate.mockResolvedValue({ status: 'created', template });
  recheckSave.mockResolvedValue({ status: 'saved', template });
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

describe('SaveAsTemplateDialog preview', () => {
  it('prepares the preview from the source team and renders the projected content', async () => {
    await render();
    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'alpha',
      name: 'Alpha',
      description: '',
    });
    expect(host.querySelector('[data-testid="custom-template-preview"]')).not.toBeNull();
    expect(host.textContent).toContain('Lead the work.');
    expect(host.textContent).toContain('ann');
    expect(host.textContent).toContain('bo');
    expect(host.textContent).toContain('customTemplates.warnings.missingMemberRole|member=bo');
    expect(host.textContent).toContain('customTemplates.preview.roleMissing');
    expect(saveButton().disabled).toBe(false);
  });

  it('explains an absent roster as a valid prompt-only template', async () => {
    preparePreview.mockResolvedValue({
      status: 'previewReady',
      preview: {
        ...preview,
        members: [],
        warnings: [{ code: 'noRecordedRoster' }],
      },
    });
    await render();
    expect(host.textContent).toContain('customTemplates.warnings.noRecordedRoster');
    expect(host.textContent).toContain('customTemplates.preview.membersEmpty');
    expect(saveButton().disabled).toBe(false);
  });

  it('explains a readable empty roster as a valid prompt-only template', async () => {
    preparePreview.mockResolvedValue({
      status: 'previewReady',
      preview: {
        ...preview,
        members: [],
        warnings: [{ code: 'emptyRoster' }],
      },
    });
    await render();
    expect(host.textContent).toContain('customTemplates.warnings.emptyRoster');
    expect(saveButton().disabled).toBe(false);
  });

  it('renders the excluded-member warning through a count-based translation', async () => {
    preparePreview.mockResolvedValue({
      status: 'previewReady',
      preview: {
        ...preview,
        warnings: [{ code: 'removedMembersExcluded', count: 1 }],
      },
    });
    await render();
    // The plural form is selected by the i18next `count` option, never by a
    // plain interpolation value.
    expect(host.textContent).toContain('customTemplates.warnings.removedMembersExcluded|count=1');
    expect(host.textContent).not.toContain('total=');
  });

  it('blocks saving for an unreadable roster and recovers through Retry', async () => {
    preparePreview.mockResolvedValueOnce({
      status: 'rosterUnreadable',
      sourceTeamName: 'alpha',
    } satisfies PrepareCustomTeamTemplatePreviewResult);
    await render();
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.rosterUnreadable'
    );
    expect(saveButton().disabled).toBe(true);

    preparePreview.mockResolvedValue(previewReady);
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(preparePreview).toHaveBeenCalledTimes(2);
    expect(saveButton().disabled).toBe(false);
  });

  it('keeps a prepare-time validation issue visible until the preview is prepared again', async () => {
    preparePreview.mockResolvedValueOnce({
      status: 'validationFailed',
      issues: [{ code: 'templateNameTooLong', field: 'name' }],
    } satisfies PrepareCustomTeamTemplatePreviewResult);
    await render();
    expect(host.textContent).toContain('customTemplates.errors.issues.templateNameTooLong');
    expect(saveButton().disabled).toBe(true);

    setText('#custom-template-name', 'Short');
    preparePreview.mockResolvedValue(previewReady);
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(preparePreview).toHaveBeenLastCalledWith({
      sourceTeamName: 'alpha',
      name: 'Short',
      description: '',
    });
    expect(saveButton().disabled).toBe(false);
  });
});

describe('SaveAsTemplateDialog save', () => {
  it('recognizes a decision event before the old marker is removed', async () => {
    await render();
    await saveUntilUnresolved();
    const old = getPendingTemplateMutations()[0];
    const decisionKey = `agent-teams:custom-template-mutation-decision:${old.id}`;
    await act(async () => {
      localStorage.setItem(decisionKey, old.kind);
      window.dispatchEvent(new StorageEvent('storage', { key: decisionKey }));
    });
    expect(host.textContent).toContain('customTemplates.states.resolvedElsewhere');
    expect(getPendingTemplateMutations()).toEqual([]);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });
  it('recognizes the decision storage event even if its marker event arrived first', async () => {
    await render();
    await saveUntilUnresolved();
    const old = getPendingTemplateMutations()[0];
    const markerKey = `agent-teams:custom-template-pending-mutation:${old.id}`;
    const decisionKey = `agent-teams:custom-template-mutation-decision:${old.id}`;
    await act(async () => {
      localStorage.removeItem(markerKey);
      window.dispatchEvent(new StorageEvent('storage', { key: markerKey }));
    });
    expect(button('customTemplates.actions.recheck')).toBeTruthy();
    await act(async () => {
      localStorage.setItem(decisionKey, old.kind);
      window.dispatchEvent(new StorageEvent('storage', { key: decisionKey }));
    });
    expect(host.textContent).toContain('customTemplates.states.resolvedElsewhere');
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });
  it('recognizes a decision made elsewhere after the unknown save is already shown', async () => {
    await render();
    await saveUntilUnresolved();
    expect(button('customTemplates.actions.recheck')).toBeTruthy();
    const old = getPendingTemplateMutations()[0];
    await act(async () => {
      expect(resolveTemplateMutation(old)).toBe(true);
    });
    expect(host.textContent).toContain('customTemplates.states.resolvedElsewhere');
    expect(
      buttons().some((candidate) =>
        candidate.textContent?.includes('customTemplates.actions.recheck')
      )
    ).toBe(false);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });
  it.each(['unresolved', 'rejected'] as const)(
    'does not ask again after another window resolved a late %s save',
    async (outcome) => {
      let resolveWrite!: (value: ConfirmCustomTeamTemplateSaveResult) => void;
      let rejectWrite!: (error: Error) => void;
      saveTemplate.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        })
      );
      await render();
      await act(async () => saveButton().click());
      const old = getPendingTemplateMutations()[0];
      await act(async () => {
        expect(resolveTemplateMutation(old)).toBe(true);
        setPendingTemplateMutation({ kind: 'edit', label: 'New action' });
      });
      await act(async () => {
        if (outcome === 'unresolved')
          resolveWrite({ status: 'unresolvedWriteOutcome', templateId: 'template-1' });
        else rejectWrite(new Error('lost response'));
      });
      expect(host.textContent).toContain('customTemplates.states.resolvedElsewhere');
      expect(
        buttons().some((candidate) =>
          candidate.textContent?.includes('customTemplates.actions.recheck')
        )
      ).toBe(false);
      expect(saveTemplate).toHaveBeenCalledTimes(1);
      expect(getPendingTemplateMutations().map((item) => item.label)).toEqual(['New action']);
    }
  );
  it('blocks a new save while a library write still needs user re-check', async () => {
    setPendingTemplateMutation({ kind: 'duplicate', label: 'Uncertain copy' });
    await render();
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="template-library-unresolved"]')?.textContent
    ).toContain(
      'Close this dialog, open Templates, and select My Templates. Select Re-check outcome, then choose whether to allow new changes. If the list is incomplete, check outside the list first.'
    );
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('submits only the editable name and description', async () => {
    await render();
    setText('#custom-template-name', 'Beta');
    setText('#custom-template-description', 'Reusable setup');
    await act(async () => {
      saveButton().click();
    });
    expect(saveTemplate).toHaveBeenCalledWith({
      previewToken: 'token-1',
      name: 'Beta',
      description: 'Reusable setup',
    });
    const request = saveTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty('teamPrompt');
    expect(request).not.toHaveProperty('members');
    expect(request).not.toHaveProperty('sourceTeamName');
  });

  it('runs a single save while one is in flight', async () => {
    let resolve!: (value: ConfirmCustomTeamTemplateSaveResult) => void;
    saveTemplate.mockReturnValue(
      new Promise<ConfirmCustomTeamTemplateSaveResult>((done) => (resolve = done))
    );
    await render();
    const save = saveButton();
    act(() => save.click());
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    act(() => save.click());
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="custom-template-saved"]')).toBeNull();

    await act(async () => {
      resolve({ status: 'created', template });
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="custom-template-saved"]')).not.toBeNull();
  });

  it('reports success only for a confirmed result and keeps the dialog open', async () => {
    await render();
    await act(async () => {
      saveButton().click();
    });
    expect(host.querySelector('[data-testid="custom-template-saved"]')).not.toBeNull();
    expect(host.textContent).toContain('customTemplates.states.savedBody|name=Alpha');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the dialog and the typed fields on a name conflict', async () => {
    saveTemplate.mockResolvedValue({
      status: 'nameConflict',
      existingTemplateId: 'template-2',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await render();
    setText('#custom-template-name', 'Taken name');
    setText('#custom-template-description', 'Keep me');
    await act(async () => {
      saveButton().click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.nameConflict'
    );
    expect(host.querySelector<HTMLInputElement>('#custom-template-name')?.value).toBe('Taken name');
    expect(host.querySelector<HTMLTextAreaElement>('#custom-template-description')?.value).toBe(
      'Keep me'
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(saveTemplate).toHaveBeenCalledTimes(1);

    setText('#custom-template-name', 'Free name');
    expect(
      host.querySelector('[data-testid="custom-template-state"]')?.textContent ?? ''
    ).not.toContain('customTemplates.errors.nameConflict');
  });

  it('refreshes the preview after a stale result, preserving the fields and requiring a new save', async () => {
    saveTemplate.mockResolvedValueOnce({
      status: 'stalePreview',
      sourceTeamName: 'alpha',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await render();
    setText('#custom-template-name', 'Beta');
    setText('#custom-template-description', 'Reviewed');
    await act(async () => {
      saveButton().click();
    });
    expect(preparePreview).toHaveBeenLastCalledWith({
      sourceTeamName: 'alpha',
      name: 'Beta',
      description: 'Reviewed',
    });
    expect(host.textContent).toContain('customTemplates.states.stalePreview');
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('#custom-template-name')?.value).toBe('Beta');
    expect(host.querySelector<HTMLTextAreaElement>('#custom-template-description')?.value).toBe(
      'Reviewed'
    );

    await act(async () => {
      saveButton().click();
    });
    expect(saveTemplate).toHaveBeenCalledTimes(2);
    expect(saveTemplate.mock.calls[1]?.[0]).toEqual({
      previewToken: 'token-1',
      name: 'Beta',
      description: 'Reviewed',
    });
  });

  it('blocks saving again while the outcome is unresolved and offers Re-check', async () => {
    await render();
    await saveUntilUnresolved();
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.states.unresolvedTitle'
    );
    expect(saveButton().disabled).toBe(true);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(recheckSave).toHaveBeenCalledWith({ previewToken: 'token-1' });
  });

  it.each(['unresolved', 'transport failure'] as const)(
    'preserves an %s outcome when the open dialog receives a new initial name',
    async (outcome) => {
      await render();
      if (outcome === 'unresolved') {
        await saveUntilUnresolved();
      } else {
        saveTemplate.mockRejectedValueOnce(new Error('response lost'));
        await act(async () => saveButton().click());
      }

      await render({ initialName: 'Updated team name' });
      expect(preparePreview).toHaveBeenCalledTimes(1);
      expect(saveTemplate).toHaveBeenCalledTimes(1);
      expect(saveButton().disabled).toBe(true);
      expect(host.querySelector('[data-testid="custom-template-state"]')).not.toBeNull();

      await act(async () => button('customTemplates.actions.recheck').click());
      expect(recheckSave).toHaveBeenCalledTimes(1);
      expect(recheckSave).toHaveBeenCalledWith({ previewToken: 'token-1' });
      expect(saveTemplate).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps an in-flight save and its original team when dialog props change', async () => {
    await render();
    let resolveSave!: (value: ConfirmCustomTeamTemplateSaveResult) => void;
    saveTemplate.mockReturnValueOnce(
      new Promise<ConfirmCustomTeamTemplateSaveResult>((resolve) => (resolveSave = resolve))
    );
    await act(async () => saveButton().click());
    await render({ initialName: 'Other', sourceTeamName: 'other-team' });
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(button('customTemplates.states.saving').disabled).toBe(true);

    await act(async () => {
      resolveSave({ status: 'unresolvedWriteOutcome', templateId: 'template-1' });
    });
    expect(saveButton().disabled).toBe(true);
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(recheckSave).toHaveBeenCalledWith({ previewToken: 'token-1' });
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('keeps a previous unknown save blocked when the dialog is reopened', async () => {
    await render();
    await saveUntilUnresolved();
    await render({ open: false });
    await render({ open: true, initialName: 'Other' });
    expect(host.querySelector('[data-testid="template-library-unresolved"]')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('uses the latest team and name when the dialog is explicitly closed and reopened', async () => {
    await render();
    await render({ open: false, sourceTeamName: 'other-team', initialName: 'Other' });
    preparePreview.mockResolvedValueOnce({
      status: 'previewReady',
      preview: { ...preview, sourceTeamName: 'other-team', previewToken: 'token-2' },
    } satisfies PrepareCustomTeamTemplatePreviewResult);
    await render({ open: true, sourceTeamName: 'other-team', initialName: 'Other' });
    expect(preparePreview).toHaveBeenCalledTimes(2);
    expect(preparePreview).toHaveBeenLastCalledWith({
      sourceTeamName: 'other-team',
      name: 'Other',
      description: '',
    });
    expect(host.textContent).toContain('other-team');
  });

  it('blocks dismissal only while a save is in flight', async () => {
    await render();
    expect(host.querySelector('[data-close-disabled]')?.getAttribute('data-close-disabled')).toBe(
      'false'
    );

    let resolve!: (value: ConfirmCustomTeamTemplateSaveResult) => void;
    saveTemplate.mockReturnValue(
      new Promise<ConfirmCustomTeamTemplateSaveResult>((done) => (resolve = done))
    );
    act(() => saveButton().click());
    expect(host.querySelector('[data-close-disabled]')?.getAttribute('data-close-disabled')).toBe(
      'true'
    );
    act(() => button('actions.close').click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ status: 'created', template });
      await Promise.resolve();
    });
    act(() => button('actions.close').click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('treats a failed save request as an unknown outcome instead of a failure', async () => {
    saveTemplate.mockRejectedValueOnce(new Error('offline'));
    await render();
    await act(async () => {
      saveButton().click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.saveOutcomeUnknown'
    );
    expect(saveButton().disabled).toBe(true);
    expect(buttons().some((candidate) => candidate.textContent?.includes('recheck'))).toBe(true);
  });
});

describe('SaveAsTemplateDialog re-check', () => {
  it('keeps the unknown outcome if a re-check reports an invalid token', async () => {
    recheckSave.mockResolvedValue({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => button('customTemplates.actions.recheck').click());
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(true);
    expect(buttons().some((candidate) => candidate.textContent?.includes('recheck'))).toBe(true);
  });

  it('maps a confirmed save to the success state', async () => {
    recheckSave.mockResolvedValue({
      status: 'saved',
      template,
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(host.querySelector('[data-testid="custom-template-saved"]')).not.toBeNull();
    expect(buttons().some((candidate) => candidate.textContent?.includes('actions.save'))).toBe(
      false
    );
  });

  it('does not retry when an older server reports absence after an unknown save', async () => {
    recheckSave.mockResolvedValue({
      status: 'notSaved',
      templateId: 'template-1',
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.states.unresolvedTitle'
    );
    expect(saveButton().disabled).toBe(true);
    await act(async () => {
      saveButton().click();
    });
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('reports a conflicting template id distinctly and stops saving', async () => {
    recheckSave.mockResolvedValue({
      status: 'templateIdConflict',
      templateId: 'template-1',
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.templateIdConflict'
    );
    expect(saveButton().disabled).toBe(true);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable library distinctly and keeps Re-check available', async () => {
    recheckSave.mockResolvedValue({
      status: 'storageUnavailable',
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.storageUnavailableRecheck'
    );
    expect(saveButton().disabled).toBe(true);
    expect(buttons().some((candidate) => candidate.textContent?.includes('recheck'))).toBe(true);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
  });

  it('keeps the unresolved outcome and the Re-check action when the store stays unreadable', async () => {
    recheckSave.mockResolvedValue({
      status: 'unresolved',
      templateId: 'template-1',
    } satisfies RecheckCustomTeamTemplateSaveResult);
    await render();
    await saveUntilUnresolved();
    await act(async () => {
      button('customTemplates.actions.recheck').click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.states.unresolvedTitle'
    );
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(buttons().some((candidate) => candidate.textContent?.includes('recheck'))).toBe(true);
  });
});

describe('SaveAsTemplateDialog blocked source', () => {
  it('shows a recoverable error without a preview when the source disappears', async () => {
    saveTemplate.mockResolvedValueOnce({
      status: 'sourceUnavailable',
      sourceTeamName: 'alpha',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await render();
    await act(async () => {
      saveButton().click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.sourceUnavailable'
    );
    expect(saveButton().disabled).toBe(true);
    preparePreview.mockResolvedValue(previewReady);
    await act(async () => {
      button('customTemplates.actions.retry').click();
    });
    expect(preparePreview).toHaveBeenCalledTimes(2);
    expect(saveButton().disabled).toBe(false);
  });

  it('reports a refused write without claiming success and keeps saving allowed', async () => {
    saveTemplate.mockResolvedValueOnce({
      status: 'storageUnavailable',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await render();
    await act(async () => {
      saveButton().click();
    });
    expect(host.querySelector('[data-testid="custom-template-state"]')?.textContent).toContain(
      'customTemplates.errors.storageUnavailableSave'
    );
    expect(host.querySelector('[data-testid="custom-template-saved"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});
