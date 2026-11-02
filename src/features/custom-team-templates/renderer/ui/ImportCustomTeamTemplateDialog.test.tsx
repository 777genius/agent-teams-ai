import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const importTemplate = vi.hoisted(() => vi.fn());
const browserFile = vi.hoisted(() => ({ importFromFile: vi.fn() }));
const desktopFile = vi.hoisted(() => ({ importFromFile: vi.fn() }));

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
  useTemplateFileOperations: () => ({
    platform: 'browser',
    desktopFile: undefined,
    browserFile,
  }),
}));

import { ImportCustomTeamTemplateDialog } from './ImportCustomTeamTemplateDialog';

import type {
  ImportCustomTeamTemplateFromBrowserFileResult,
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
});
