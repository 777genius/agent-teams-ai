import {
  CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
  type BrowserFileDownload,
  type ExportCustomTeamTemplateResult,
  type ImportCustomTeamTemplateResult,
  type PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

import { CustomTeamTemplateBrowserFileService, DefaultBrowserFileDownload } from '@features/custom-team-templates/renderer/adapters/browserCustomTeamTemplatesFile';

import { describe, expect, it, vi } from 'vitest';

const PORTABLE: PortableCustomTeamTemplateV1 = {
  format: 'agent-teams-custom-template',
  schemaVersion: 1,
  name: 'Release Pipeline',
  description: 'Ships releases.',
  teamPrompt: 'Plan\nShip',
  members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build\nTest' }],
};

function makeFile(opts: { contents: string; name?: string; size?: number; type?: string }): File {
  return new File([opts.contents], opts.name ?? 'template.json', {
    type: opts.type ?? 'application/json',
  }) as unknown as File;
}

function executors(
  importResult: ImportCustomTeamTemplateResult = {
    status: 'imported',
    template: {
      templateId: 'tmpl-new',
      name: 'N',
      schemaVersion: 1,
      teamPrompt: '',
      members: [],
      revision: 1,
    },
  },
  exportResult: ExportCustomTeamTemplateResult = { status: 'exported', portable: PORTABLE }
) {
  return {
    importTemplate: vi.fn(() => Promise.resolve(importResult)),
    exportTemplate: vi.fn(() => Promise.resolve(exportResult)),
  };
}

function downloadMock() {
  const calls: { blob: Blob; fileName: string }[] = [];
  const downloadFn = vi.fn((_blob: Blob, fileName: string) => {
    calls.push({ blob: _blob, fileName });
    return Promise.resolve();
  });
  const download: BrowserFileDownload = { download: downloadFn };
  return { download, calls, downloadFn };
}

describe('CustomTeamTemplateBrowserFileService import', () => {
  it('imports a valid portable JSON file through the application use case', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result.status).toBe('imported');
    expect(importTemplate).toHaveBeenCalledWith({ portable: PORTABLE });
  });

  it('decodes Unicode content', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const unicodePortable = { ...PORTABLE, name: 'تیم محصول', teamPrompt: 'سلام دنیا' };
    const file = makeFile({ contents: JSON.stringify(unicodePortable) });
    const result = await service.importFromFile(file);

    expect(result.status).toBe('imported');
    expect(importTemplate).toHaveBeenCalledWith({ portable: unicodePortable });
  });

  it('preserves multiline prompt and member instructions', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const multiline = {
      ...PORTABLE,
      teamPrompt: 'Line 1\nLine 2\nLine 3',
      members: [{ name: 'a', workflow: 'Step 1\nStep 2' }],
    };
    const file = makeFile({ contents: JSON.stringify(multiline) });
    const result = await service.importFromFile(file);

    expect(result.status).toBe('imported');
    expect(importTemplate).toHaveBeenCalledWith({ portable: multiline });
  });

  it('strips a UTF-8 BOM before parsing', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new Uint8Array([...bom, ...new TextEncoder().encode(JSON.stringify(PORTABLE))]);
    const file = new File([body], 'template.json', { type: 'application/json' }) as unknown as File;
    const result = await service.importFromFile(file);

    expect(result.status).toBe('imported');
    expect(importTemplate).toHaveBeenCalledWith({ portable: PORTABLE });
  });

  it('rejects invalid UTF-8', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const invalidUtf8 = new Uint8Array([0xc0, 0x80, 0xed, 0xa0, 0x80]);
    const file = new File([invalidUtf8], 'template.json', {
      type: 'application/json',
    }) as unknown as File;
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'invalidEncoding' });
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: '{not valid json' });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'invalidJson' });
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('rejects oversized files before reading', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
      maxImportFileBytes: 100,
    });

    const oversized = makeFile({ contents: 'x'.repeat(200) });
    const result = await service.importFromFile(oversized);

    expect(result).toEqual({ status: 'fileTooLarge', maxBytes: 100 });
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('uses the documented 128 MiB default limit', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const oversized = makeFile({
      contents: 'x'.repeat(CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES + 1),
    });
    const result = await service.importFromFile(oversized);

    expect(result).toEqual({
      status: 'fileTooLarge',
      maxBytes: CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
    });
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('reports a file read failure', async () => {
    const { importTemplate } = executors();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const throwingFile = {
      size: 10,
      arrayBuffer: vi.fn(() => Promise.reject(new Error('disk error'))),
    } as unknown as File;
    const result = await service.importFromFile(throwingFile);

    expect(result).toEqual({ status: 'fileReadFailed' });
    expect(importTemplate).not.toHaveBeenCalled();
  });

  it('reports transport/network failure as storageUnavailable', async () => {
    const { importTemplate } = executors({
      status: 'storageUnavailable',
    });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'storageUnavailable' });
    expect(importTemplate).toHaveBeenCalledWith({ portable: PORTABLE });
  });

  it('keeps domain validation failures distinct from file-level errors', async () => {
    const { importTemplate } = executors({
      status: 'validationFailed',
      issues: [{ code: 'teamPromptTooLong', field: 'teamPrompt' }],
    });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result.status).toBe('validationFailed');
    if (result.status === 'validationFailed') {
      expect(result.issues).toEqual([{ code: 'teamPromptTooLong', field: 'teamPrompt' }]);
    }
  });

  it('reports nameConflict with sanitized portable content', async () => {
    const existingId = 'tmpl-existing';
    const { importTemplate } = executors({
      status: 'nameConflict',
      existingTemplateId: existingId,
      portable: PORTABLE,
    });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result.status).toBe('nameConflict');
    if (result.status === 'nameConflict') {
      expect(result.existingTemplateId).toBe(existingId);
      expect(result.portable).toEqual(PORTABLE);
    }
  });

  it('reports unsupported format', async () => {
    const { importTemplate } = executors({ status: 'unsupportedFormat', format: 'wrong' });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({
      contents: JSON.stringify({
        format: 'wrong',
        schemaVersion: 1,
        name: 'N',
        teamPrompt: '',
        members: [],
      }),
    });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'unsupportedFormat', format: 'wrong' });
  });

  it('reports unsupported version', async () => {
    const { importTemplate } = executors({ status: 'unsupportedVersion', version: 2 });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (
        payload: unknown
      ) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify({ ...PORTABLE, schemaVersion: 2 }) });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'unsupportedVersion', version: 2 });
  });
});

describe('CustomTeamTemplateBrowserFileService export', () => {
  it('exports only portable contract fields as deterministic UTF-8 JSON and downloads', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'exported' });
    expect(exportTemplate).toHaveBeenCalledWith({ templateId: 'tmpl-1' });
    expect(calls).toHaveLength(1);

    const { blob, fileName } = calls[0];
    expect(fileName).toBe('Release Pipeline.json');
    expect(blob.type).toBe('application/json');

    const text = await blob.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'format',
      'schemaVersion',
      'name',
      'description',
      'teamPrompt',
      'members',
    ]);
    expect(parsed).toEqual(PORTABLE);
    expect(text).not.toContain('tmpl-1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('uses the correct exportTemplate request shape', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    await service.exportToFile({ templateId: 'tmpl-42' });
    expect(exportTemplate).toHaveBeenCalledWith({ templateId: 'tmpl-42' });
  });

  it('reports notFound without downloading', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'notFound',
      templateId: 'missing',
    });
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'missing' });

    expect(result).toEqual({ status: 'notFound', templateId: 'missing' });
    expect(download.download).not.toHaveBeenCalled();
  });

  it('reports unreadableRecord without downloading', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'unreadableRecord',
      templateId: 'tmpl-1',
    });
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'unreadableRecord', templateId: 'tmpl-1' });
    expect(download.download).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable without downloading', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'storageUnavailable',
    });
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'storageUnavailable' });
    expect(download.download).not.toHaveBeenCalled();
  });

  it('preserves Unicode and multiline content in export', async () => {
    const unicodePortable = {
      ...PORTABLE,
      name: 'تیم محصول',
      teamPrompt: 'سلام دنیا\nخط دوم',
      members: [{ name: 'عضو', role: 'مهندس', workflow: 'ساخت\nآزمون' }],
    };
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: unicodePortable,
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'exported' });
    const text = await calls[0].blob.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toEqual(unicodePortable);
    expect(text).toContain('سلام دنیا');
  });

  it('does not leak internal persistence metadata', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    await service.exportToFile({ templateId: 'tmpl-1' });
    const text = await calls[0].blob.text();
    expect(text).not.toContain('tmpl-secret');
    expect(text).not.toContain('revision');
    expect(text).not.toContain('createdAt');
  });

  it('uses a safe suggested filename', async () => {
    const unsafePortable = { ...PORTABLE, name: '../Evil/Name' };
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: unsafePortable,
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    await service.exportToFile({ templateId: 'tmpl-1' });
    expect(calls[0].fileName).toBe('Evil Name.json');
  });

  it('uses JSON MIME type on the Blob', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    await service.exportToFile({ templateId: 'tmpl-1' });
    expect(calls[0].blob.type).toBe('application/json');
  });

  it('reports download failure without claiming success', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    const { download, downloadFn } = downloadMock();
    downloadFn.mockImplementationOnce(() => Promise.reject(new Error('download failed')));
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'downloadFailed' });
  });

  it('does not download when the application export fails', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'notFound',
      templateId: 'missing',
    });
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (
        payload: unknown
      ) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'missing' });

    expect(result).toEqual({ status: 'notFound', templateId: 'missing' });
    expect(download.download).not.toHaveBeenCalled();
  });

  it('classifies import executor throw as transportFailed, not storageUnavailable', async () => {
    const { importTemplate } = executors();
    importTemplate.mockRejectedValueOnce(new Error('network down'));
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (payload: unknown) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'transportFailed' });
    expect(importTemplate).toHaveBeenCalledWith({ portable: PORTABLE });
  });

  it('classifies export executor throw as transportFailed, not storageUnavailable', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'exported',
      portable: PORTABLE,
    });
    exportTemplate.mockRejectedValueOnce(new Error('network down'));
    const { download } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (payload: unknown) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'transportFailed' });
    expect(download.download).not.toHaveBeenCalled();
  });

  it('keeps domain storageUnavailable distinct from transport failure on import', async () => {
    const { importTemplate } = executors({ status: 'storageUnavailable' });
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: importTemplate as unknown as (payload: unknown) => Promise<ImportCustomTeamTemplateResult>,
      exportTemplate: vi.fn(),
    });

    const file = makeFile({ contents: JSON.stringify(PORTABLE) });
    const result = await service.importFromFile(file);

    expect(result).toEqual({ status: 'storageUnavailable' });
  });

  it('keeps domain storageUnavailable distinct from transport failure on export', async () => {
    const { exportTemplate } = executors(undefined as unknown as ImportCustomTeamTemplateResult, {
      status: 'storageUnavailable',
    });
    const { download, calls } = downloadMock();
    const service = new CustomTeamTemplateBrowserFileService({
      importTemplate: vi.fn(),
      exportTemplate: exportTemplate as unknown as (payload: unknown) => Promise<ExportCustomTeamTemplateResult>,
      download,
    });

    const result = await service.exportToFile({ templateId: 'tmpl-1' });

    expect(result).toEqual({ status: 'storageUnavailable' });
    expect(calls).toHaveLength(0);
  });

  describe('DefaultBrowserFileDownload', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes the anchor element after dispatching the download', async () => {
      const download = new DefaultBrowserFileDownload();
      const appendSpy = vi.spyOn(document.body, 'appendChild');
      const removeSpy = vi.spyOn(document.body, 'removeChild');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      const createSpy = vi.spyOn(URL, 'createObjectURL');

      const blob = new Blob(['{}'], { type: 'application/json' });
      await download.download(blob, 'test.json');

      expect(createSpy).toHaveBeenCalledWith(blob);
      expect(appendSpy).toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalled();

      // Advance timers to trigger the deferred URL revocation.
      vi.advanceTimersByTime(100);
      expect(revokeSpy).toHaveBeenCalled();

      appendSpy.mockRestore();
      removeSpy.mockRestore();
      revokeSpy.mockRestore();
      createSpy.mockRestore();
    });

    it('does not leak object URLs', async () => {
      const download = new DefaultBrowserFileDownload();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      const blob = new Blob(['{}'], { type: 'application/json' });
      await download.download(blob, 'test.json');

      // URL should be revoked asynchronously after the click
      vi.advanceTimersByTime(100);
      expect(revokeSpy).toHaveBeenCalled();

      revokeSpy.mockRestore();
    });
  });
});
