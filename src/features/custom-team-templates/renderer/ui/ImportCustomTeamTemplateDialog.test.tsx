import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const importTemplate = vi.hoisted(() => vi.fn());
const browserFile = vi.hoisted(() => ({ importFromFile: vi.fn() }));
const desktopFile = vi.hoisted(() => ({ importFromFile: vi.fn() }));
/** Platform the mocked capability hook reports; tests switch it per case. */
const platformRef = vi.hoisted(() => ({ current: 'browser' as 'browser' | 'electron' | 'none' }));

vi.mock('@renderer/api', () => ({
  api: {
    customTeamTemplates: {
      importTemplate,
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

vi.mock('../hooks/useTemplateFileOperations', () => ({
  useTemplateFileOperations: () => {
    if (platformRef.current === 'electron') {
      return { platform: 'electron', desktopFile, browserFile: undefined };
    }
    if (platformRef.current === 'none') {
      return { platform: 'none', desktopFile: undefined, browserFile: undefined };
    }
    return { platform: 'browser', desktopFile: undefined, browserFile };
  },
}));

import { ImportCustomTeamTemplateDialog } from './ImportCustomTeamTemplateDialog';

import type {
  CustomTeamTemplateV1,
  ImportCustomTeamTemplateFromBrowserFileResult,
  ImportCustomTeamTemplateFromFileResult,
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

const portable: PortableCustomTeamTemplateV1 = {
  format: 'agent-teams-custom-template',
  schemaVersion: 1,
  name: 'Release Pipeline',
  description: 'Ships releases.',
  teamPrompt: 'Ship it.',
  members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build' }],
};

/** Saved record returned by a successful import. */
const importedTemplate: CustomTeamTemplateV1 = {
  templateId: 'tmpl-new',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Ship it.',
  members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build' }],
  revision: 1,
};

function importedResult(name = 'Release Pipeline'): ImportCustomTeamTemplateResult {
  return { status: 'imported', template: { ...importedTemplate, name } };
}

function conflictResult(): ImportCustomTeamTemplateResult {
  return { status: 'nameConflict', existingTemplateId: 'tmpl-existing', portable };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(<ImportCustomTeamTemplateDialog open onClose={onClose} />);
  });
}

function fileInput(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>('#import-file-input');
  if (!field) throw new Error(`file input not found\n${host.textContent}`);
  return field;
}

function importButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.import.action')
  );
  if (!found) throw new Error(`import button not found\n${host.textContent}`);
  return found;
}

function renameInput(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>('#import-rename-name');
  if (!field) throw new Error(`rename input not found\n${host.textContent}`);
  return field;
}

function confirmButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.import.confirmImport')
  );
  if (!found) throw new Error(`confirm button not found\n${host.textContent}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  platformRef.current = 'browser';
  importTemplate.mockReset();
  browserFile.importFromFile.mockReset();
  desktopFile.importFromFile.mockReset();
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

function importResult(
  status: ImportCustomTeamTemplateFromBrowserFileResult['status'],
  extra?: Record<string, unknown>
): ImportCustomTeamTemplateFromBrowserFileResult {
  return { status, ...extra } as ImportCustomTeamTemplateFromBrowserFileResult;
}

function closeButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('actions.close')
  );
  if (!found) throw new Error(`close button not found\n${host.textContent}`);
  return found;
}

function closeButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter((candidate) =>
    candidate.textContent?.includes('actions.close')
  );
}

/** Selects a JSON file through the browser file input and waits for the result. */
async function selectPortableFile(): Promise<void> {
  const input = fileInput();
  Object.defineProperty(input, 'files', {
    value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Asserts the dialog is usable again: not busy, Close and Import enabled. */
function expectInteractiveAfterFailure(): void {
  const close = closeButton();
  expect(close.disabled).toBe(false);
  const action = importButton();
  expect(action.disabled).toBe(false);
  expect(action.textContent).toContain('customTemplates.import.action');
}

/**
 * Edits the rename field the way a real user does.
 *
 * The native value setter is used so React's internal value tracker observes the
 * change; assigning `input.value` directly would be swallowed.
 */
async function typeRenameName(value: string): Promise<void> {
  const input = renameInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ImportCustomTeamTemplateDialog', () => {
  it('shows the file input when browser capability is available', async () => {
    await render();
    expect(fileInput()).not.toBeNull();
  });

  it('invokes browserFile.importFromFile when a file is selected', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('imported', {
        template: {
          templateId: 'tmpl-new',
          name: 'N',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })
    );

    await render();
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(fileInput(), 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      fileInput().dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(browserFile.importFromFile).toHaveBeenCalledWith(expect.any(File));
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('resets the file input after processing so the same file can be selected again', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('imported', {
        template: {
          templateId: 'tmpl-new',
          name: 'N',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })
    );

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input.value).toBe('');
  });

  it('shows success when import completes', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('imported', {
        template: {
          templateId: 'tmpl-new',
          name: 'N',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })
    );

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
  });

  it('opens the rename dialog on nameConflict', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('nameConflict', { existingTemplateId: 'tmpl-existing', portable })
    );

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();
    expect(renameInput().value).toBe(portable.name);
  });

  it('retries import with the renamed portable on rename confirm', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('nameConflict', { existingTemplateId: 'tmpl-existing', portable })
    );
    importTemplate.mockResolvedValue({
      status: 'imported',
      template: {
        templateId: 'tmpl-new',
        name: 'Renamed',
        schemaVersion: 1,
        teamPrompt: '',
        members: [],
        revision: 1,
      },
    } satisfies ImportCustomTeamTemplateResult);

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      confirmButton().click();
    });

    expect(importTemplate).toHaveBeenCalledTimes(1);
    const callArg = importTemplate.mock.calls[0][0];
    expect(callArg.portable).toMatchObject({
      format: portable.format,
      schemaVersion: portable.schemaVersion,
      description: portable.description,
      teamPrompt: portable.teamPrompt,
      members: portable.members,
    });
    expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
  });

  it('preserves all other portable fields during rename', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('nameConflict', { existingTemplateId: 'tmpl-existing', portable })
    );
    importTemplate.mockResolvedValue({
      status: 'imported',
      template: {
        templateId: 'tmpl-new',
        name: 'Renamed',
        schemaVersion: 1,
        teamPrompt: '',
        members: [],
        revision: 1,
      },
    } satisfies ImportCustomTeamTemplateResult);

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      confirmButton().click();
    });

    const callArg = importTemplate.mock.calls[0][0];
    expect(callArg.portable).toMatchObject({
      format: portable.format,
      schemaVersion: portable.schemaVersion,
      description: portable.description,
      teamPrompt: portable.teamPrompt,
      members: portable.members,
    });
  });

  it('allows another rename attempt when nameConflict recurs', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('nameConflict', { existingTemplateId: 'tmpl-existing', portable })
    );
    importTemplate.mockResolvedValueOnce(
      importResult('nameConflict', {
        existingTemplateId: 'tmpl-existing',
        portable: { ...portable, name: 'FirstAttempt' },
      })
    );
    importTemplate.mockResolvedValueOnce({
      status: 'imported',
      template: {
        templateId: 'tmpl-new',
        name: 'Final',
        schemaVersion: 1,
        teamPrompt: '',
        members: [],
        revision: 1,
      },
    } satisfies ImportCustomTeamTemplateResult);

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const rename = renameInput();
    rename.value = 'FirstAttempt';
    await act(async () => {
      rename.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      confirmButton().click();
    });

    // Still in conflict, rename again
    rename.value = 'Final';
    await act(async () => {
      rename.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      confirmButton().click();
    });

    expect(importTemplate).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
  });

  it('does not blindly retry on unresolvedWriteOutcome', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('nameConflict', { existingTemplateId: 'tmpl-existing', portable })
    );
    importTemplate.mockResolvedValue({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-unknown',
    } satisfies ImportCustomTeamTemplateResult);

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const rename = renameInput();
    rename.value = 'Renamed';
    await act(async () => {
      rename.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      confirmButton().click();
    });

    expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
    expect(importTemplate).toHaveBeenCalledTimes(1);
  });

  it('shows invalidJson for malformed JSON', async () => {
    browserFile.importFromFile.mockResolvedValue(importResult('invalidJson'));

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-invalid-json"]')).not.toBeNull();
  });

  it('shows invalidEncoding for invalid UTF-8', async () => {
    browserFile.importFromFile.mockResolvedValue(importResult('invalidEncoding'));

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-invalid-encoding"]')).not.toBeNull();
  });

  it('shows fileTooLarge for oversized files', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('fileTooLarge', { maxBytes: 128 * 1024 * 1024 })
    );

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-file-too-large"]')).not.toBeNull();
  });

  it('shows transportFailed for network failures', async () => {
    browserFile.importFromFile.mockResolvedValue(importResult('transportFailed'));

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-transport-failed"]')).not.toBeNull();
  });

  it('cancels without error when user cancels', async () => {
    browserFile.importFromFile.mockResolvedValue(importResult('cancelled'));

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-testid="import-template-invalid-json"]')).toBeNull();
    expect(host.querySelector('[data-testid="import-template-storage-unavailable"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reloads the library when the dialog closes after a successful import', async () => {
    browserFile.importFromFile.mockResolvedValue(
      importResult('imported', {
        template: {
          templateId: 'tmpl-new',
          name: 'N',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })
    );

    await render();
    const input = fileInput();
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Close the done dialog
    const closeButton = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('actions.close')
    );
    if (closeButton) {
      await act(async () => {
        closeButton.click();
      });
    }

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders exactly one Close control after a successful import', async () => {
    browserFile.importFromFile.mockResolvedValue(importedResult());

    await render();
    await selectPortableFile();

    expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
    expect(closeButtons()).toHaveLength(1);
  });

  describe('handled browser failures', () => {
    const cases: readonly {
      label: string;
      result: ImportCustomTeamTemplateFromBrowserFileResult;
      testId: string;
    }[] = [
      {
        label: 'invalidJson',
        result: { status: 'invalidJson' },
        testId: 'import-template-invalid-json',
      },
      {
        label: 'invalidEncoding',
        result: { status: 'invalidEncoding' },
        testId: 'import-template-invalid-encoding',
      },
      {
        label: 'fileTooLarge',
        result: { status: 'fileTooLarge', maxBytes: 1024 },
        testId: 'import-template-file-too-large',
      },
      {
        label: 'fileReadFailed',
        result: { status: 'fileReadFailed' },
        testId: 'import-template-file-read-failed',
      },
      {
        label: 'transportFailed',
        result: { status: 'transportFailed' },
        testId: 'import-template-transport-failed',
      },
      {
        label: 'unsupportedFormat',
        result: { status: 'unsupportedFormat' },
        testId: 'import-template-unsupported-format',
      },
      {
        label: 'unsupportedVersion',
        result: { status: 'unsupportedVersion' },
        testId: 'import-template-unsupported-version',
      },
      {
        label: 'storageUnavailable',
        result: { status: 'storageUnavailable' },
        testId: 'import-template-storage-unavailable',
      },
      {
        label: 'templateIdConflict',
        result: { status: 'templateIdConflict', templateId: 'tmpl-1' },
        testId: 'import-template-id-conflict',
      },
    ];

    it.each(cases)('leaves the dialog interactive after $label', async ({ result, testId }) => {
      browserFile.importFromFile.mockResolvedValue(result);

      await render();
      await selectPortableFile();

      expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      expectInteractiveAfterFailure();
    });

    it('keeps validation feedback visible and names the unexpected property', async () => {
      browserFile.importFromFile.mockResolvedValue({
        status: 'validationFailed',
        issues: [{ code: 'unexpectedProperty', field: 'templateId', parameter: 'templateId' }],
      });

      await render();
      await selectPortableFile();

      const banner = host.querySelector('[data-testid="import-template-validation-failed"]');
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain('customTemplates.errors.issues.unexpectedProperty');
      expect(banner?.textContent).toContain('property=templateId');
      expectInteractiveAfterFailure();
    });

    it('allows a retry after a handled failure', async () => {
      browserFile.importFromFile
        .mockResolvedValueOnce({ status: 'invalidJson' })
        .mockResolvedValueOnce(importedResult());

      await render();
      await selectPortableFile();
      expect(host.querySelector('[data-testid="import-template-invalid-json"]')).not.toBeNull();

      await selectPortableFile();

      expect(browserFile.importFromFile).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
    });

    it('blocks another browser import after an unresolved write', async () => {
      browserFile.importFromFile.mockResolvedValue({
        status: 'unresolvedWriteOutcome',
        templateId: '',
      });

      await render();
      await selectPortableFile();

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="import-template-transport-failed"]')).toBeNull();
      expect(fileInput().disabled).toBe(true);
      expect(importButton().disabled).toBe(true);
      expect(closeButton().disabled).toBe(false);
      expect(browserFile.importFromFile).toHaveBeenCalledTimes(1);

      // The file input is disabled, so selecting another file cannot dispatch a
      // second import from the same uncertain dialog flow.
      const input = fileInput();
      Object.defineProperty(input, 'files', {
        value: [
          new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' }),
        ],
        configurable: true,
      });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(browserFile.importFromFile).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
    });

    it('allows a retry after a definitive validation failure', async () => {
      browserFile.importFromFile
        .mockResolvedValueOnce({
          status: 'validationFailed',
          issues: [{ code: 'templateNameRequired', field: 'name' }],
        })
        .mockResolvedValueOnce(importedResult());

      await render();
      await selectPortableFile();
      expect(
        host.querySelector('[data-testid="import-template-validation-failed"]')
      ).not.toBeNull();
      expectInteractiveAfterFailure();

      await selectPortableFile();

      expect(browserFile.importFromFile).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
    });

    it('stays silent and interactive when the user cancels', async () => {
      browserFile.importFromFile.mockResolvedValue({ status: 'cancelled' });

      await render();
      await selectPortableFile();

      expect(host.querySelector('[data-testid="import-template-invalid-json"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expectInteractiveAfterFailure();
    });

    it('opens the rename flow on a name conflict', async () => {
      browserFile.importFromFile.mockResolvedValue(conflictResult());

      await render();
      await selectPortableFile();

      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();
      expect(renameInput().value).toBe('Release Pipeline');
      expect(confirmButton().disabled).toBe(false);
    });
  });

  describe('handled desktop failures', () => {
    const cases: readonly {
      label: string;
      result: ImportCustomTeamTemplateFromFileResult;
      testId: string;
    }[] = [
      {
        label: 'fileChanged',
        result: { status: 'fileChanged' },
        testId: 'import-template-file-changed',
      },
      {
        label: 'filePickerFailed',
        result: { status: 'filePickerFailed' },
        testId: 'import-template-file-picker-failed',
      },
      {
        label: 'fileReadFailed',
        result: { status: 'fileReadFailed' },
        testId: 'import-template-file-read-failed',
      },
      {
        label: 'invalidJson',
        result: { status: 'invalidJson' },
        testId: 'import-template-invalid-json',
      },
      {
        label: 'invalidEncoding',
        result: { status: 'invalidEncoding' },
        testId: 'import-template-invalid-encoding',
      },
      {
        label: 'fileTooLarge',
        result: { status: 'fileTooLarge', maxBytes: 1024 },
        testId: 'import-template-file-too-large',
      },
      {
        label: 'unsupportedFormat',
        result: { status: 'unsupportedFormat' },
        testId: 'import-template-unsupported-format',
      },
      {
        label: 'unsupportedVersion',
        result: { status: 'unsupportedVersion' },
        testId: 'import-template-unsupported-version',
      },
      {
        label: 'storageUnavailable',
        result: { status: 'storageUnavailable' },
        testId: 'import-template-storage-unavailable',
      },
      {
        label: 'validationFailed',
        result: {
          status: 'validationFailed',
          issues: [{ code: 'unexpectedProperty', field: 'extra', parameter: 'extra' }],
        },
        testId: 'import-template-validation-failed',
      },
    ];

    beforeEach(() => {
      platformRef.current = 'electron';
    });

    it.each(cases)(
      'leaves the dialog interactive after desktop $label',
      async ({ result, testId }) => {
        desktopFile.importFromFile.mockResolvedValue(result);

        await render();
        await act(async () => {
          importButton().click();
        });

        expect(desktopFile.importFromFile).toHaveBeenCalledTimes(1);
        expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
        expectInteractiveAfterFailure();
      }
    );

    it('retries a desktop import after a handled failure', async () => {
      desktopFile.importFromFile
        .mockResolvedValueOnce({ status: 'filePickerFailed' })
        .mockResolvedValueOnce(importedResult());

      await render();
      await act(async () => {
        importButton().click();
      });
      expect(
        host.querySelector('[data-testid="import-template-file-picker-failed"]')
      ).not.toBeNull();

      await act(async () => {
        importButton().click();
      });

      expect(desktopFile.importFromFile).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
    });

    it('blocks another desktop import after an unresolved write', async () => {
      desktopFile.importFromFile.mockResolvedValue({
        status: 'unresolvedWriteOutcome',
        templateId: '',
      });

      await render();
      await act(async () => {
        importButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(importButton().disabled).toBe(true);
      expect(closeButton().disabled).toBe(false);
      expect(desktopFile.importFromFile).toHaveBeenCalledTimes(1);

      await act(async () => {
        importButton().click();
      });

      expect(desktopFile.importFromFile).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
    });

    it('reaches done after a successful desktop import', async () => {
      desktopFile.importFromFile.mockResolvedValue(importedResult());

      await render();
      await act(async () => {
        importButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
      expect(closeButtons()).toHaveLength(1);
    });

    it('opens the rename flow when the desktop import hits a name conflict', async () => {
      desktopFile.importFromFile.mockResolvedValue(conflictResult());

      await render();
      await act(async () => {
        importButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();
      expect(renameInput().value).toBe('Release Pipeline');
    });
  });

  describe('rename retry', () => {
    async function startConflict(): Promise<void> {
      browserFile.importFromFile.mockResolvedValue(conflictResult());
      await render();
      await selectPortableFile();
      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();
    }

    it('keeps the imported portable content apart from the chosen name', async () => {
      importTemplate.mockResolvedValue(importedResult());

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(importTemplate).toHaveBeenCalledTimes(1);
      expect(importTemplate.mock.calls[0]?.[0]).toEqual({ portable });
    });

    it('clears a stale failure banner when a later retry succeeds', async () => {
      importTemplate
        .mockResolvedValueOnce({ status: 'storageUnavailable' })
        .mockResolvedValueOnce(importedResult('Release Pipeline Copy'));

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(
        host.querySelector('[data-testid="import-template-storage-unavailable"]')
      ).not.toBeNull();
      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();

      await typeRenameName('Release Pipeline Copy');
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="import-template-storage-unavailable"]')).toBeNull();
      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).toBeNull();
      expect(importTemplate).toHaveBeenCalledTimes(2);
      expect(importTemplate.mock.calls[1]?.[0]).toEqual({
        portable: { ...portable, name: 'Release Pipeline Copy' },
      });
    });

    it('does not re-send an unresolved write and blocks the confirm action', async () => {
      importTemplate.mockResolvedValue({
        status: 'unresolvedWriteOutcome',
        templateId: 'tmpl-new',
      });

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(confirmButton().disabled).toBe(true);

      await act(async () => {
        confirmButton().click();
      });

      expect(importTemplate).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
    });

    it('maps a rejected rename import to unresolvedWriteOutcome and blocks retries', async () => {
      importTemplate.mockRejectedValue(new Error('transport rejected after dispatch'));

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="import-template-done"]')).toBeNull();
      expect(host.querySelector('[data-testid="import-template-transport-failed"]')).toBeNull();
      expect(confirmButton().disabled).toBe(true);

      // Retry must not dispatch another write.
      await act(async () => {
        confirmButton().click();
      });
      expect(importTemplate).toHaveBeenCalledTimes(1);

      // Changing the rename input cannot bypass the guard.
      await typeRenameName('Another Name');
      await act(async () => {
        confirmButton().click();
      });
      expect(importTemplate).toHaveBeenCalledTimes(1);

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
    });

    it('keeps repeated name conflicts resolvable', async () => {
      importTemplate
        .mockResolvedValueOnce({
          status: 'nameConflict',
          existingTemplateId: 'tmpl-2',
          portable: { ...portable, name: 'Taken' },
        })
        .mockResolvedValueOnce(importedResult('Taken'));

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(renameInput().value).toBe('Taken');
      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();

      await act(async () => {
        confirmButton().click();
      });

      expect(importTemplate).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="import-template-done"]')).not.toBeNull();
    });

    it('clears rename validation errors when cancelling a conflict', async () => {
      importTemplate.mockResolvedValue({
        status: 'validationFailed',
        issues: [{ code: 'templateNameRequired', field: 'name' }],
      } satisfies ImportCustomTeamTemplateResult);

      await startConflict();

      await typeRenameName('Bad Name');
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('#import-rename-name-error')).not.toBeNull();
      expect(renameInput().getAttribute('aria-invalid')).toBe('true');

      const cancelButton = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('actions.cancel')
      );
      expect(cancelButton).not.toBeUndefined();
      await act(async () => {
        cancelButton!.click();
      });

      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).toBeNull();

      // A new conflict must start with a clean rename validation state.
      browserFile.importFromFile.mockResolvedValue(conflictResult());
      await selectPortableFile();

      expect(host.querySelector('[data-testid="import-template-name-conflict"]')).not.toBeNull();
      expect(renameInput().getAttribute('aria-invalid')).toBeNull();
      expect(host.querySelector('#import-rename-name-error')).toBeNull();
    });

    it('keeps unresolved write protection after cancelling a conflict', async () => {
      importTemplate.mockRejectedValue(new Error('transport rejected after dispatch'));

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();

      const cancelButton = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('actions.cancel')
      );
      expect(cancelButton).not.toBeUndefined();
      await act(async () => {
        cancelButton!.click();
      });

      // Back in idle but the unresolved write outcome persists.
      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(fileInput().disabled).toBe(true);
      expect(importButton().disabled).toBe(true);
      expect(closeButton().disabled).toBe(false);

      // Another file import cannot be dispatched while uncertainty remains.
      const input = fileInput();
      Object.defineProperty(input, 'files', {
        value: [
          new File([JSON.stringify(portable)], 'template.json', { type: 'application/json' }),
        ],
        configurable: true,
      });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(browserFile.importFromFile).toHaveBeenCalledTimes(1);
    });

    it('keeps Cancel enabled when the rename field is blank', async () => {
      await startConflict();

      // Clear the pre-filled rename name so the field is blank.
      await typeRenameName('');

      // No name entered; Cancel must still be clickable because cancelling does
      // not consume the proposed name. Only Confirm requires a nonblank name.
      const cancelButton = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('actions.cancel')
      );
      expect(cancelButton).not.toBeUndefined();
      expect(cancelButton!.disabled).toBe(false);

      const confirmBtn = confirmButton();
      expect(confirmBtn.disabled).toBe(true);
    });

    it('clears rename failure banner on Cancel but preserves unresolvedWriteOutcome', async () => {
      // A rename that fails with a definitive error sets errorState.
      importTemplate.mockResolvedValue({
        status: 'storageUnavailable',
      } satisfies ImportCustomTeamTemplateResult);

      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(
        host.querySelector('[data-testid="import-template-storage-unavailable"]')
      ).not.toBeNull();

      const cancelButton = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('actions.cancel')
      );
      expect(cancelButton).not.toBeUndefined();
      await act(async () => {
        cancelButton!.click();
      });

      // Back in idle, the definitive failure banner is cleared.
      expect(host.querySelector('[data-testid="import-template-storage-unavailable"]')).toBeNull();

      // An unresolved write must survive cancellation and keep blocking retries.
      importTemplate.mockRejectedValue(new Error('transport rejected after dispatch'));
      await startConflict();
      await act(async () => {
        confirmButton().click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      const cancelButton2 = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('actions.cancel')
      );
      expect(cancelButton2).not.toBeUndefined();
      await act(async () => {
        cancelButton2!.click();
      });

      expect(host.querySelector('[data-testid="import-template-unresolved"]')).not.toBeNull();
      expect(fileInput().disabled).toBe(true);
      expect(closeButton().disabled).toBe(false);
    });
  });
});
