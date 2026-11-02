import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserFile = vi.hoisted(() => ({ exportToFile: vi.fn() }));
const desktopFile = vi.hoisted(() => ({ exportToFile: vi.fn() }));

vi.mock('../hooks/useTemplateFileOperations', () => ({
  useTemplateFileOperations: () => ({
    platform: 'browser',
    desktopFile: undefined,
    browserFile,
  }),
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

import { ExportCustomTeamTemplateDialog } from './ExportCustomTeamTemplateDialog';

import type { ExportCustomTeamTemplateToBrowserFileResult } from '@features/custom-team-templates/contracts';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(
      <ExportCustomTeamTemplateDialog
        open
        templateId="tmpl-1"
        templateName="Release Pipeline"
        onClose={onClose}
      />
    );
  });
}

function exportButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.export.action')
  );
  if (!found) throw new Error(`export button not found\n${host.textContent}`);
  return found;
}

function closeButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('actions.close')
  );
  if (!found) throw new Error(`close button not found\n${host.textContent}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  browserFile.exportToFile.mockReset();
  desktopFile.exportToFile.mockReset();
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

function exportResult(
  status: ExportCustomTeamTemplateToBrowserFileResult['status'],
  extra?: Record<string, unknown>
): ExportCustomTeamTemplateToBrowserFileResult {
  return { status, ...extra } as ExportCustomTeamTemplateToBrowserFileResult;
}

describe('ExportCustomTeamTemplateDialog', () => {
  it('invokes browserFile.exportToFile with the template ID', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('exported'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(browserFile.exportToFile).toHaveBeenCalledWith({ templateId: 'tmpl-1' });
  });

  it('shows success when export completes', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('exported'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(host.querySelector('[data-testid="export-template-done"]')).not.toBeNull();
  });

  it('prevents duplicate export operations while busy', async () => {
    let resolveExport: (value: ExportCustomTeamTemplateToBrowserFileResult) => void = () => {};
    const exportPromise = new Promise<ExportCustomTeamTemplateToBrowserFileResult>((resolve) => {
      resolveExport = resolve;
    });
    browserFile.exportToFile.mockReturnValue(exportPromise);

    await render();
    await act(async () => {
      exportButton().click();
    });
    // While busy, a second export should not be triggered
    expect(browserFile.exportToFile).toHaveBeenCalledTimes(1);

    resolveExport(exportResult('exported'));
    await act(async () => {
      await exportPromise;
    });
  });

  it('handles notFound without downloading', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('notFound', { templateId: 'tmpl-1' }));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(host.querySelector('[data-testid="export-template-not-found"]')).not.toBeNull();
    expect(browserFile.exportToFile).toHaveBeenCalledTimes(1);
  });

  it('handles storageUnavailable', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('storageUnavailable'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(
      host.querySelector('[data-testid="export-template-storage-unavailable"]')
    ).not.toBeNull();
  });

  it('handles downloadFailed', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('downloadFailed'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(host.querySelector('[data-testid="export-template-download-failed"]')).not.toBeNull();
  });

  it('handles transportFailed', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('transportFailed'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(host.querySelector('[data-testid="export-template-transport-failed"]')).not.toBeNull();
  });

  it('cancellation does not show an error', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('cancelled'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    expect(host.querySelector('[data-testid="export-template-download-failed"]')).toBeNull();
    expect(host.querySelector('[data-testid="export-template-storage-unavailable"]')).toBeNull();
  });

  it('closes the dialog and resets state', async () => {
    browserFile.exportToFile.mockResolvedValue(exportResult('exported'));

    await render();
    await act(async () => {
      exportButton().click();
    });

    await act(async () => {
      closeButton().click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
