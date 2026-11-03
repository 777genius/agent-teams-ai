import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
} from '@features/custom-team-templates/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InternalStorageFeature } from '@features/internal-storage/main';

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
});

/** Fake native file gateway; the desktop file service is composed for real. */
const fileGateway = vi.hoisted(() => ({
  pickImportFile: vi.fn(),
  readUtf8File: vi.fn(),
  pickExportDestination: vi.fn(),
  writeFileAtomically: vi.fn(),
}));

const featureMock = vi.hoisted(() => ({
  importTemplate: { execute: vi.fn() },
  exportTemplate: { execute: vi.fn() },
  preparePreview: { execute: vi.fn() },
  saveTemplate: { execute: vi.fn() },
  recheckSave: { execute: vi.fn() },
  listTemplates: { execute: vi.fn() },
  updateTemplate: { execute: vi.fn() },
  deleteTemplate: { execute: vi.fn() },
  duplicateTemplate: { execute: vi.fn() },
  copyBuiltinTemplate: { execute: vi.fn() },
  dispose: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipc.handle, removeHandler: ipc.removeHandler },
}));

vi.mock('@features/custom-team-templates/main', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/custom-team-templates/main')>();
  return {
    ...actual,
    createCustomTeamTemplatesFeature: vi.fn(() => featureMock),
    // Startup composes the real desktop file service, so only the native file
    // boundary is replaced; that keeps the wiring assertions meaningful.
    ElectronCustomTeamTemplateFileGateway: vi.fn().mockImplementation(function gatewayStub() {
      return fileGateway;
    }),
  };
});

import { startCustomTeamTemplatesFeature } from '@main/startCustomTeamTemplatesFeature';

function internalStorage(): InternalStorageFeature {
  return { customTeamTemplatesBackend: { workerPath: null } } as unknown as InternalStorageFeature;
}

describe('startCustomTeamTemplatesFeature', () => {
  beforeEach(() => {
    ipc.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every shared data channel and both desktop file channels at startup', () => {
    startCustomTeamTemplatesFeature(internalStorage());

    expect([...ipc.handlers.keys()].sort((left, right) => left.localeCompare(right))).toEqual(
      [
        ...Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS),
        ...Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS),
      ].sort((left, right) => left.localeCompare(right))
    );
    expect(ipc.handlers.size).toBe(12);
  });

  it('wires desktop import to the composed import use case', async () => {
    const portableDocument = {
      format: 'agent-teams-custom-template',
      schemaVersion: 1,
      name: 'Release Pipeline',
      description: 'Ships releases.',
      teamPrompt: 'Ship it.',
      members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build' }],
    };
    const importedTemplate = {
      templateId: 'tmpl-new',
      name: 'Release Pipeline',
      schemaVersion: 1,
      teamPrompt: 'Ship it.',
      members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build' }],
      revision: 1,
    };
    const filePath = join(tmpdir(), 'template.json');
    fileGateway.pickImportFile.mockResolvedValue(filePath);
    fileGateway.readUtf8File.mockResolvedValue({
      status: 'ok',
      contents: JSON.stringify(portableDocument),
    });
    featureMock.importTemplate.execute.mockResolvedValue({
      status: 'imported',
      template: importedTemplate,
    });

    const startup = startCustomTeamTemplatesFeature(internalStorage());
    expect(startup.importTemplate).toBe(featureMock.importTemplate);

    const handler = ipc.handlers.get(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile);
    expect(handler).toBeTypeOf('function');

    // Invoke the registered handler: it must drive the composed use case end to
    // end, not merely exist.
    const result = await handler?.({ sender: 'renderer' });

    expect(fileGateway.pickImportFile).toHaveBeenCalledTimes(1);
    expect(fileGateway.readUtf8File).toHaveBeenCalledWith(
      filePath,
      CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES
    );
    expect(featureMock.importTemplate.execute).toHaveBeenCalledTimes(1);
    expect(featureMock.importTemplate.execute).toHaveBeenCalledWith({ portable: portableDocument });
    expect(result).toEqual({ status: 'imported', template: importedTemplate });
  });

  it('answers with a typed outcome when the desktop import is cancelled', async () => {
    fileGateway.pickImportFile.mockResolvedValue(null);
    startCustomTeamTemplatesFeature(internalStorage());

    const handler = ipc.handlers.get(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile);
    const result = await handler?.({ sender: 'renderer' });

    expect(result).toEqual({ status: 'cancelled' });
    expect(featureMock.importTemplate.execute).not.toHaveBeenCalled();
  });

  it('removes every handler and disposes the composed feature once', () => {
    const startup = startCustomTeamTemplatesFeature(internalStorage());
    expect(ipc.handlers.size).toBe(12);

    startup.dispose();

    expect(ipc.handlers.size).toBe(0);
    expect(ipc.removeHandler).toHaveBeenCalledTimes(12);
    expect(featureMock.dispose).toHaveBeenCalledTimes(1);
  });
});
