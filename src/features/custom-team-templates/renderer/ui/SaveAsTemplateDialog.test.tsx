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

  it('re-enables saving after a confirmed absence', async () => {
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
      'customTemplates.states.notSaved'
    );
    expect(saveButton().disabled).toBe(false);
    await act(async () => {
      saveButton().click();
    });
    expect(saveTemplate).toHaveBeenCalledTimes(2);
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
