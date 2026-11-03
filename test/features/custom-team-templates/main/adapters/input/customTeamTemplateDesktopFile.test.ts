import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES } from '@features/custom-team-templates/contracts';
import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { ExportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ExportCustomTeamTemplateUseCase';
import { ImportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ImportCustomTeamTemplateUseCase';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { CustomTeamTemplateDesktopFileService } from '@features/custom-team-templates/main/services/CustomTeamTemplateDesktopFileService';
import { describe, expect, it, vi } from 'vitest';

import type {
  CustomTeamTemplateStorageGateway,
  CustomTeamTemplateV1,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';
import type {
  CustomTeamTemplateFileGateway,
  CustomTeamTemplateFileReadResult,
} from '@features/custom-team-templates/main/adapters/output/CustomTeamTemplateFileGateway';

const hasher = new NodeCustomTeamTemplateHasher();
const importFilePath = join(tmpdir(), 'template.json');
const exportFilePath = join(tmpdir(), 'export.json');

const PORTABLE: PortableCustomTeamTemplateV1 = {
  format: 'agent-teams-custom-template',
  schemaVersion: 1,
  name: 'Release Pipeline',
  description: 'Ships releases.',
  teamPrompt: 'Plan\nShip',
  members: [
    { name: 'engineer', role: 'Engineer\nReviewer', workflow: 'Build\nTest' },
    { name: 'reviewer' },
  ],
};

function library(initial: readonly CustomTeamTemplateV1[] = []) {
  const rows = new Map(initial.map((template) => [template.templateId, { ...template }]));
  const gateway: CustomTeamTemplateStorageGateway = {
    customTeamTemplateCreate: vi.fn<CustomTeamTemplateStorageGateway['customTeamTemplateCreate']>(
      (request) => {
        const sameId = rows.get(request.template.templateId);
        if (sameId) {
          return Promise.resolve({ status: 'alreadySaved', template: sameId });
        }
        const nameKey = request.template.name.trim().toLowerCase();
        for (const row of rows.values()) {
          if (row.name.trim().toLowerCase() === nameKey) {
            return Promise.resolve({
              status: 'conflict',
              reason: 'nameTaken',
              existingTemplateId: row.templateId,
            });
          }
        }
        const template: CustomTeamTemplateV1 = {
          ...request.template,
          createdAt: '2026-01-01T00:00:00.000Z',
        };
        rows.set(template.templateId, template);
        return Promise.resolve({ status: 'created', template });
      }
    ),
    customTeamTemplateList: vi.fn(() =>
      Promise.resolve({
        templates: [...rows.values()],
        unreadableRecords: [],
      })
    ),
    customTeamTemplateGetById: vi.fn<CustomTeamTemplateStorageGateway['customTeamTemplateGetById']>(
      ({ templateId }) => {
        const found = rows.get(templateId);
        return Promise.resolve(
          found ? { status: 'found', template: found } : { status: 'notFound' }
        );
      }
    ),
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
  return { gateway, rows };
}

function readResult(
  result: CustomTeamTemplateFileReadResult
): CustomTeamTemplateFileGateway['readUtf8File'] {
  return vi.fn<CustomTeamTemplateFileGateway['readUtf8File']>(() => Promise.resolve(result));
}

function files(
  overrides: Partial<CustomTeamTemplateFileGateway> = {}
): CustomTeamTemplateFileGateway {
  return {
    pickImportFile: vi.fn(() => Promise.resolve(importFilePath)),
    readUtf8File: readResult({ status: 'ok', contents: JSON.stringify(PORTABLE) }),
    pickExportDestination: vi.fn(() => Promise.resolve(exportFilePath)),
    writeFileAtomically: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function importService(
  gateway: CustomTeamTemplateStorageGateway | null,
  fileGateway: CustomTeamTemplateFileGateway,
  createTemplateId: () => string = () => 'tmpl-imported'
) {
  return new CustomTeamTemplateDesktopFileService({
    importTemplate: new ImportCustomTeamTemplateUseCase({
      gateway,
      hasher,
      createTemplateId,
    }),
    exportTemplate: new ExportCustomTeamTemplateUseCase({ gateway }),
    files: fileGateway,
  });
}

describe('CustomTeamTemplateDesktopFileService import', () => {
  it('imports a valid portable JSON file through the application use case', async () => {
    const { gateway } = library();
    const fileGateway = files();
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result.status).toBe('imported');
    if (result.status === 'imported') {
      expect(result.template.templateId).toBe('tmpl-imported');
      expect(result.template.revision).toBe(1);
      expect(result.template.name).toBe('Release Pipeline');
      expect(result.template.teamPrompt).toBe('Plan\nShip');
      expect(result.template.members[0]).toEqual({
        name: 'engineer',
        role: 'Engineer\nReviewer',
        workflow: 'Build\nTest',
      });
    }
    expect(fileGateway.readUtf8File).toHaveBeenCalledWith(
      importFilePath,
      CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES
    );
  });

  it('treats picker cancellation as a normal outcome and never reads the file', async () => {
    const { gateway } = library();
    const fileGateway = files({ pickImportFile: vi.fn(() => Promise.resolve(null)) });
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result).toEqual({ status: 'cancelled' });
    expect(fileGateway.readUtf8File).not.toHaveBeenCalled();
    expect(gateway.customTeamTemplateCreate).not.toHaveBeenCalled();
  });

  it('reports invalid JSON without invoking the use case', async () => {
    const { gateway } = library();
    const fileGateway = files({
      readUtf8File: readResult({ status: 'ok', contents: '{not json' }),
    });
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result).toEqual({ status: 'invalidJson' });
    expect(gateway.customTeamTemplateCreate).not.toHaveBeenCalled();
  });

  it('reports invalid UTF-8', async () => {
    const { gateway } = library();
    const fileGateway = files({
      readUtf8File: readResult({ status: 'invalidEncoding' }),
    });
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result).toEqual({ status: 'invalidEncoding' });
  });

  it('rejects an oversized file before parsing', async () => {
    const { gateway } = library();
    const fileGateway = files({
      readUtf8File: readResult({
        status: 'tooLarge',
        maxBytes: CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
      }),
    });
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result).toEqual({
      status: 'fileTooLarge',
      maxBytes: CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
    });
    expect(gateway.customTeamTemplateCreate).not.toHaveBeenCalled();
  });

  it('rejects a file that changed between inspection and read', async () => {
    const { gateway } = library();
    const fileGateway = files({
      readUtf8File: readResult({ status: 'changedDuringRead' }),
    });
    const result = await importService(gateway, fileGateway).importFromFile();

    expect(result).toEqual({ status: 'fileChanged' });
  });

  it('maps read and picker failures to file-level outcomes', async () => {
    const { gateway } = library();
    const readFailure = await importService(
      gateway,
      files({ readUtf8File: readResult({ status: 'readFailed' }) })
    ).importFromFile();
    expect(readFailure).toEqual({ status: 'fileReadFailed' });

    const pickerFailure = await importService(
      gateway,
      files({ pickImportFile: vi.fn(async () => Promise.reject(new Error('dialog failed'))) })
    ).importFromFile();
    expect(pickerFailure).toEqual({ status: 'filePickerFailed' });
  });

  it('passes unsupported format and version through from the use case', async () => {
    const { gateway } = library();
    const wrongFormat = await importService(
      gateway,
      files({
        readUtf8File: readResult({
          status: 'ok',
          contents: JSON.stringify({ ...PORTABLE, format: 'other' }),
        }),
      })
    ).importFromFile();
    expect(wrongFormat.status).toBe('unsupportedFormat');

    const wrongVersion = await importService(
      gateway,
      files({
        readUtf8File: readResult({
          status: 'ok',
          contents: JSON.stringify({ ...PORTABLE, schemaVersion: 2 }),
        }),
      })
    ).importFromFile();
    expect(wrongVersion.status).toBe('unsupportedVersion');
  });

  it('reports domain validation failures from the shared policy', async () => {
    const { gateway } = library();
    const result = await importService(
      gateway,
      files({
        readUtf8File: readResult({
          status: 'ok',
          contents: JSON.stringify({ ...PORTABLE, name: '' }),
        }),
      })
    ).importFromFile();

    expect(result.status).toBe('validationFailed');
  });

  it('retains sanitized content on a name conflict and never overwrites the existing template', async () => {
    const existing: CustomTeamTemplateV1 = {
      templateId: 'tmpl-existing',
      name: 'Release Pipeline',
      schemaVersion: 1,
      teamPrompt: 'Original',
      members: [],
    };
    const { gateway, rows } = library([existing]);
    const result = await importService(gateway, files()).importFromFile();

    expect(result.status).toBe('nameConflict');
    if (result.status === 'nameConflict') {
      expect(result.existingTemplateId).toBe('tmpl-existing');
      expect(result.portable).toEqual(PORTABLE);
    }
    expect(rows.get('tmpl-existing')).toEqual(existing);
    expect(rows.size).toBe(1);
  });

  it('reports storage failure without claiming success', async () => {
    const gateway = library().gateway;
    gateway.customTeamTemplateCreate = vi.fn(() => Promise.reject(new Error('worker unavailable')));
    const result = await importService(gateway, files()).importFromFile();

    expect(result).toEqual({ status: 'storageUnavailable' });
  });

  it('never rejects when the import use case throws unexpectedly', async () => {
    const service = new CustomTeamTemplateDesktopFileService({
      importTemplate: {
        execute: vi.fn(() => Promise.reject(new Error('unexpected'))),
      },
      exportTemplate: { execute: vi.fn() },
      files: files(),
    });

    await expect(service.importFromFile()).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('reports an unresolved write outcome when reconciliation cannot confirm the result', async () => {
    const gateway = library().gateway;
    gateway.customTeamTemplateCreate = vi.fn(() =>
      Promise.reject(
        new CustomTeamTemplateStorageInterruptedError(
          'worker died mid-write',
          'unknown',
          Promise.resolve()
        )
      )
    );
    gateway.customTeamTemplateGetById = vi.fn<
      CustomTeamTemplateStorageGateway['customTeamTemplateGetById']
    >(({ templateId }) =>
      Promise.resolve({
        status: 'unreadable',
        templateId,
      })
    );

    const result = await importService(gateway, files()).importFromFile();

    expect(result).toEqual({ status: 'unresolvedWriteOutcome', templateId: 'tmpl-imported' });
  });

  it('uses the file content, not the selected filename, as template identity', async () => {
    const { gateway } = library();
    const result = await importService(
      gateway,
      files({ pickImportFile: vi.fn(() => Promise.resolve('C:\\untrusted\\Taken Name.json')) })
    ).importFromFile();

    expect(result.status).toBe('imported');
    if (result.status === 'imported') {
      expect(result.template.name).toBe('Release Pipeline');
    }
  });

  it('rejects member objects with unexpected properties instead of persisting them', async () => {
    const { gateway } = library();
    const portableWithExtra = {
      ...PORTABLE,
      members: [{ ...PORTABLE.members[0], provider: 'attacker', cwd: '/etc' }],
    };
    const result = await importService(
      gateway,
      files({
        readUtf8File: readResult({
          status: 'ok',
          contents: JSON.stringify(portableWithExtra),
        }),
      })
    ).importFromFile();

    expect(result.status).toBe('validationFailed');
    expect(gateway.customTeamTemplateCreate).not.toHaveBeenCalled();
  });
});

describe('CustomTeamTemplateDesktopFileService export', () => {
  const stored: CustomTeamTemplateV1 = {
    templateId: 'tmpl-1',
    name: 'Release Pipeline',
    description: 'Ships releases.',
    schemaVersion: 1,
    teamPrompt: 'Plan\nShip',
    members: [{ name: 'engineer', role: 'Engineer\nReviewer', workflow: 'Build\nTest' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 4,
  };

  it('exports only portable contract fields as deterministic UTF-8 JSON', async () => {
    const { gateway } = library([stored]);
    const fileGateway = files();
    const result = await importService(gateway, fileGateway).exportToFile({
      templateId: 'tmpl-1',
    });

    expect(result).toEqual({ status: 'exported' });
    expect(fileGateway.pickExportDestination).toHaveBeenCalledWith('Release Pipeline.json');
    const written = (fileGateway.writeFileAtomically as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      'format',
      'schemaVersion',
      'name',
      'description',
      'teamPrompt',
      'members',
    ]);
    expect(parsed).toEqual({
      format: 'agent-teams-custom-template',
      schemaVersion: 1,
      name: 'Release Pipeline',
      description: 'Ships releases.',
      teamPrompt: 'Plan\nShip',
      members: [{ name: 'engineer', role: 'Engineer\nReviewer', workflow: 'Build\nTest' }],
    });
    expect(written).not.toContain('tmpl-1');
    expect(written).not.toContain('2026-01-01');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('treats save-dialog cancellation as a normal outcome and writes nothing', async () => {
    const { gateway } = library([stored]);
    const fileGateway = files({ pickExportDestination: vi.fn(() => Promise.resolve(null)) });
    const result = await importService(gateway, fileGateway).exportToFile({
      templateId: 'tmpl-1',
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(fileGateway.writeFileAtomically).not.toHaveBeenCalled();
  });

  it('reports a missing template without opening the save dialog', async () => {
    const { gateway } = library();
    const fileGateway = files();
    const result = await importService(gateway, fileGateway).exportToFile({
      templateId: 'missing',
    });

    expect(result).toEqual({ status: 'notFound', templateId: 'missing' });
    expect(fileGateway.pickExportDestination).not.toHaveBeenCalled();
  });

  it('reports storage unavailability without opening the save dialog', async () => {
    const fileGateway = files();
    const result = await importService(null, fileGateway).exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'storageUnavailable' });
    expect(fileGateway.pickExportDestination).not.toHaveBeenCalled();
  });

  it('reports a write failure', async () => {
    const { gateway } = library([stored]);
    const result = await importService(
      gateway,
      files({
        writeFileAtomically: vi.fn(async () => Promise.reject(new Error('disk full'))),
      })
    ).exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'fileWriteFailed' });
  });

  it('rejects a malformed request and ignores renderer-supplied paths', async () => {
    const { gateway } = library([stored]);
    const fileGateway = files();
    const service = importService(gateway, fileGateway);

    expect(await service.exportToFile({ templateId: '  ' })).toEqual({
      status: 'invalidRequest',
    });

    await service.exportToFile({
      templateId: 'tmpl-1',
      filePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      destination: '/etc/passwd',
    });
    expect(fileGateway.pickExportDestination).toHaveBeenCalledWith('Release Pipeline.json');
    expect(fileGateway.writeFileAtomically).toHaveBeenCalledWith(
      exportFilePath,
      expect.any(String)
    );
  });

  it('round-trips export -> import with a fresh identity and leaves the original untouched', async () => {
    const original = library([stored]);
    const fileGateway = files();
    const exportResult = await importService(original.gateway, fileGateway).exportToFile({
      templateId: 'tmpl-1',
    });
    expect(exportResult).toEqual({ status: 'exported' });

    const serialized = (fileGateway.writeFileAtomically as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    const copyLibrary = library();
    const importResult = await importService(
      copyLibrary.gateway,
      files({ readUtf8File: readResult({ status: 'ok', contents: serialized }) }),
      () => 'tmpl-copy'
    ).importFromFile();

    expect(importResult.status).toBe('imported');
    if (importResult.status === 'imported') {
      expect(importResult.template.templateId).toBe('tmpl-copy');
      expect(importResult.template.name).toBe(stored.name);
      expect(importResult.template.description).toBe(stored.description);
      expect(importResult.template.teamPrompt).toBe(stored.teamPrompt);
      expect(importResult.template.members).toEqual(stored.members);
      expect(importResult.template.createdAt).toBe('2026-01-01T00:00:00.000Z');
    }
    expect(original.rows.get('tmpl-1')).toEqual(stored);
  });
});
