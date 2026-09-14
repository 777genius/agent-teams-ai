import { describe, expect, it, vi } from 'vitest';

import {
  OPEN_CODE_VERSION_TIMEOUT_MS,
  probeOpenCodeBinaryVersion,
} from './openCodeVersionDiagnostics';

import type { RuntimeProviderManagementErrorDiagnosticsDto } from '../../contracts';
import type { OpenCodeVersionDiagnosticPorts } from './OpenCodeVersionDiagnosticPorts';

function createPorts(input: {
  execute?: OpenCodeVersionDiagnosticPorts['execute'];
  monotonicTimes?: number[];
}) {
  const monotonicTimes = [...(input.monotonicTimes ?? [100, 100])];
  const warnings: Array<{
    message: string;
    diagnostics: RuntimeProviderManagementErrorDiagnosticsDto;
  }> = [];
  const ports: OpenCodeVersionDiagnosticPorts = {
    execute:
      input.execute ??
      vi.fn(async () => ({
        stdout: '1.2.3\n',
      })),
    createReportId: vi.fn(() => 'oc-fixed-report'),
    monotonicNow: vi.fn(() => monotonicTimes.shift() ?? 100),
    timestampNow: vi.fn(() => '2026-09-14T12:00:00.000Z'),
    metadata: vi.fn(() => ({
      appVersion: '9.8.7',
      platform: 'test-platform',
      arch: 'test-arch',
    })),
    warn: vi.fn((message, diagnostics) => warnings.push({ message, diagnostics })),
  };
  return { ports, warnings };
}

describe('probeOpenCodeBinaryVersion', () => {
  it('executes the version command with the preserved timeout and trims its result', async () => {
    const execute = vi.fn(async () => ({ stdout: '  1.2.3  \n' }));
    const { ports } = createPorts({ execute });

    await expect(probeOpenCodeBinaryVersion('/runtime/opencode', ports)).resolves.toEqual({
      ok: true,
      version: '1.2.3',
    });
    expect(execute).toHaveBeenCalledWith('/runtime/opencode', ['--version'], {
      timeout: 30_000,
      windowsHide: true,
    });
    expect(ports.createReportId).not.toHaveBeenCalled();
    expect(ports.warn).not.toHaveBeenCalled();
  });

  it('preserves a successful empty version as null', async () => {
    const { ports } = createPorts({ execute: vi.fn(async () => ({ stdout: '  \n' })) });

    await expect(probeOpenCodeBinaryVersion('opencode', ports)).resolves.toEqual({
      ok: true,
      version: null,
    });
  });

  it('builds the cache-facing failure shape entirely from injected host capabilities', async () => {
    const failure = Object.assign(
      new Error('Command failed: Authorization: Bearer private-value'),
      {
        code: 17,
        signal: 'SIGTERM',
        stderr: 'api_key=private-value',
        stdout: 'token=private-value',
      }
    );
    const { ports, warnings } = createPorts({
      execute: vi.fn(async () => Promise.reject(failure)),
      monotonicTimes: [100.2, 114.8],
    });

    const result = await probeOpenCodeBinaryVersion('/runtime/opencode', ports);

    expect(result).toEqual({
      ok: false,
      error: 'Command failed: Authorization: [redacted]',
      diagnostics: {
        schemaVersion: 1,
        reportId: 'oc-fixed-report',
        timestamp: '2026-09-14T12:00:00.000Z',
        appVersion: '9.8.7',
        platform: 'test-platform',
        arch: 'test-arch',
        stage: 'version_probe',
        binaryRole: 'opencode',
        durationMs: 15,
        timeoutMs: OPEN_CODE_VERSION_TIMEOUT_MS,
        timedOut: false,
        signal: 'SIGTERM',
        summary: 'Command failed: Authorization: [redacted]',
        likelyCause: null,
        binaryPath: '/runtime/opencode',
        command: '--version',
        projectPath: null,
        exitCode: 17,
        stderrPreview: 'api_key=[redacted]',
        stdoutPreview: 'token=[redacted]',
        hints: [],
      },
    });
    expect(warnings).toEqual([
      {
        message: 'OpenCode version probe failed, report oc-fixed-report',
        diagnostics: result.ok ? undefined : result.diagnostics,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-value');
  });

  it.each([
    {
      name: 'timeout',
      error: Object.assign(
        new Error(`Command timed out after ${OPEN_CODE_VERSION_TIMEOUT_MS}ms: opencode --version`),
        { signal: 'SIGKILL' }
      ),
      timedOut: true,
      exitCode: null,
      systemErrorCode: undefined,
    },
    {
      name: 'abort',
      error: Object.assign(new Error('Command aborted: opencode --version'), {
        signal: 'SIGTERM',
      }),
      timedOut: false,
      exitCode: null,
      systemErrorCode: undefined,
    },
    {
      name: 'system failure',
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      timedOut: false,
      exitCode: null,
      systemErrorCode: 'ENOENT',
    },
  ])('keeps the $name classification distinct', async (input) => {
    const { ports } = createPorts({
      execute: vi.fn(async () => Promise.reject(input.error)),
    });

    const result = await probeOpenCodeBinaryVersion('opencode', ports);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected version probe failure');
    expect(result.diagnostics).toMatchObject({
      timedOut: input.timedOut,
      exitCode: input.exitCode,
    });
    expect(result.diagnostics.systemErrorCode).toBe(input.systemErrorCode);
  });

  it('redacts the binary path and non-Error failures before logging or returning', async () => {
    const { ports, warnings } = createPorts({
      execute: vi.fn(async () => Promise.reject('api_key=private-value')),
    });

    const result = await probeOpenCodeBinaryVersion(
      'https://user:password@example.test/private?token=private-value',
      ports
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(warnings)).not.toContain('private-value');
    if (result.ok) throw new Error('Expected version probe failure');
    expect(result.diagnostics.binaryPath).toBe('https://example.test/[path redacted]');
  });
});
