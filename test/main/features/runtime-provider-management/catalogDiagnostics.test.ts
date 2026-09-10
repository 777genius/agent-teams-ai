import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeProviderCatalogDiagnostics } from '../../../../src/features/runtime-provider-management/main/infrastructure/runtimeProviderCatalogDiagnostics';
import { normalizeRuntimeProviderDirectoryResponse } from '../../../../src/features/runtime-provider-management/main/infrastructure/runtimeProviderDirectoryResponse';
import { sanitizeRuntimeProviderDiagnostics } from '../../../../src/features/runtime-provider-management/main/infrastructure/runtimeProviderErrorBoundary';
import { installPersistentAppLog } from '../../../../src/main/utils/persistentAppLog';
import type { RuntimeProviderManagementDirectoryResponse } from '../../../../src/features/runtime-provider-management/contracts';

const execCli = vi.hoisted(() => vi.fn());
vi.mock('@main/utils/childProcess', () => ({ execCli }));
afterEach(() => vi.restoreAllMocks());
const failure = (): RuntimeProviderManagementDirectoryResponse => ({
  schemaVersion: 1, runtimeId: 'opencode',
  error: { code: 'runtime-unhealthy', recoverable: true, message: 'api_key=private-value' },
});

it('assigns one desktop ID per failure and persists the redacted ID through the existing sink', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const directory = await mkdtemp(join(tmpdir(), 'catalog-diagnostics-'));
  const sink = installPersistentAppLog({ directory, appVersion: 'test', platform: 'linux' });
  try {
    const attempt = new RuntimeProviderCatalogDiagnostics('provider_directory', null);
    const response = attempt.finish(failure());
    const id = response.error!.diagnostics!.reportId;
    expect(id).toMatch(/^oc-[a-f0-9]{32}$/);
    expect(attempt.finish(response).error!.diagnostics!.reportId).toBe(id);
    expect(sanitizeRuntimeProviderDiagnostics(response.error!.diagnostics, new Set())!.reportId).toBe(id);
    await sink.flush();
    const log = await readFile(sink.filePath, 'utf8');
    expect(log).toContain(id);
    expect(log).not.toContain('private-value');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(response.error!.diagnostics).toMatchObject({ stage: 'binary_lookup', command: null, exitCode: null });
  } finally {
    sink.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps repeated upstream IDs separate from new desktop attempts', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const response = failure();
  response.error!.diagnostics = sanitizeRuntimeProviderDiagnostics({ reportId: 'upstream-fixed' }, new Set());
  const first = new RuntimeProviderCatalogDiagnostics('provider_models', null, 'one').finish(response);
  const second = new RuntimeProviderCatalogDiagnostics('provider_models', null, 'one').finish(response);
  expect(first.error!.diagnostics!.upstreamReportId).toBe('upstream-fixed');
  expect(first.error!.diagnostics!.reportId).not.toBe(second.error!.diagnostics!.reportId);
});

it.each([
  [7, undefined, false],
  ['ENOENT', undefined, false],
  [undefined, 'SIGTERM', true],
])('records actual process failure code %s and signal %s', async (code, signal, timeout) => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  execCli.mockRejectedValueOnce(Object.assign(new Error(timeout ? 'Command timed out after 90ms: fixture' : 'failed'), {
    code, signal, stderr: 'token=private-value',
  }));
  const attempt = new RuntimeProviderCatalogDiagnostics('provider_models', null, 'one');
  await expect(attempt.exec('/fixture/runtime', ['runtime', 'providers', 'models'], { timeout: 90 })).rejects.toThrow();
  const diagnostics = attempt.finish(failure()).error!.diagnostics!;
  expect(diagnostics).toMatchObject({
    binaryRole: 'orchestrator', stage: 'runtime_command', timeoutMs: 90, timedOut: timeout,
    exitCode: typeof code === 'number' ? code : null,
  });
  expect(diagnostics.systemErrorCode).toBe(typeof code === 'string' ? code : undefined);
  expect(diagnostics.signal).toBe(signal);
  expect(diagnostics.durationMs).toBeGreaterThanOrEqual(0);
  expect(diagnostics.stderrPreview).not.toContain('private-value');
});

it('does not confuse normalized inventory timeout with a successful outer process', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  execCli.mockResolvedValueOnce({ stdout: '{}', stderr: '' });
  const attempt = new RuntimeProviderCatalogDiagnostics('provider_directory', null);
  await attempt.exec('/fixture/runtime', ['runtime', 'providers', 'directory'], { timeout: 90000 });
  const response = normalizeRuntimeProviderDirectoryResponse({
    schemaVersion: 1, runtimeId: 'opencode', directory: {
      runtimeId: 'opencode', entries: [], diagnostics: ['OpenCode inventory probe timed out after 5000ms'],
    },
  } as RuntimeProviderManagementDirectoryResponse, true);
  const result = attempt.finish(response);
  expect(result.error!.diagnostics).toMatchObject({ exitCode: 0, timedOut: false, timeoutMs: 90000 });
  expect(normalizeRuntimeProviderDirectoryResponse(result, true).error!.diagnostics!.reportId)
    .toBe(result.error!.diagnostics!.reportId);
});
