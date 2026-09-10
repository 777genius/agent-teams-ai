vi.mock('@shared/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return name === 'OpenCodeVersionDiagnostics' ? { ...logger, warn: vi.fn() } : logger;
    },
  };
});

import { describe, expect, it, vi } from 'vitest';

import {
  cleanRuntimeDiagnosticText,
  normalizeRuntimeErrorDetails,
} from '../../../../src/features/runtime-provider-management/contracts/errorDiagnostics';
import { sanitizeRuntimeProviderDiagnostics } from '../../../../src/features/runtime-provider-management/main/infrastructure/runtimeProviderErrorBoundary';

const execCli = vi.hoisted(() => vi.fn());
vi.mock('@main/utils/childProcess', () => ({ execCli }));
import { probeOpenCodeBinaryVersion } from '../../../../src/features/runtime-provider-management/main/infrastructure/openCodeVersionDiagnostics';

describe('OpenCode diagnostic transport', () => {
  it('preserves useful platform paths and correlation IDs in opt-in support reports', () => {
    for (const value of [
      '/Users/alice/bin/opencode',
      '/home/alice/opencode',
      String.raw`C:\Users\alice\opencode.cmd`,
      'oc-1234567890abcdef1234567890abcdef',
    ]) {
      expect(cleanRuntimeDiagnosticText(value)).toBe(value);
    }
  });
  it('retains factual HTTP data while dropping credentials and arbitrary fields', () => {
    const result = sanitizeRuntimeProviderDiagnostics(
      {
        schemaVersion: 1,
        stage: 'catalog_http',
        httpStatus: 503,
        httpMethod: 'GET',
        endpoint: 'http://user:password@127.0.0.1:9876/provider?token=private',
        durationMs: 12.5,
        timeoutMs: 15000,
        timedOut: false,
        cause: 'connect ECONNREFUSED',
        headers: { authorization: 'secret' },
        stderrPreview: 'Authorization: Bearer private-value',
      },
      new Set()
    );
    expect(result).toMatchObject({
      stage: 'catalog_http',
      httpStatus: 503,
      endpoint: 'http://127.0.0.1:9876/provider',
      durationMs: 13,
      timeoutMs: 15000,
      timedOut: false,
      cause: 'connect ECONNREFUSED',
    });
    expect(JSON.stringify(result)).not.toMatch(/private|password|headers|secret/);
  });

  it('accepts legacy errors without inventing stages or status', () => {
    expect(sanitizeRuntimeProviderDiagnostics(null, new Set())).toBeNull();
    const result = sanitizeRuntimeProviderDiagnostics({ summary: 'old runtime' }, new Set());
    expect(result?.summary).toBe('old runtime');
    expect(result?.stage).toBeUndefined();
    expect(result?.httpStatus).toBeUndefined();
    expect(result?.exitCode).toBeNull();
  });

  it('rejects invalid measurements and cyclic cause without serializing the input', () => {
    const input: Record<string, unknown> = {
      durationMs: -1,
      timeoutMs: Infinity,
      httpStatus: 0,
      stage: 'invented',
    };
    input.cause = input;
    expect(normalizeRuntimeErrorDetails(input)).toEqual({});
  });

  it('redacts before limiting output, including secret URLs and quoted keys', () => {
    const input = `api_key=${'s'.repeat(8000)}\nhttps://user:password@localhost/private-secret?token=hidden`;
    const text = cleanRuntimeDiagnosticText(input)!;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain('ssss');
    expect(text).not.toMatch(/password|private-secret|hidden/);
    expect(cleanRuntimeDiagnosticText('x'.repeat(8000))).toContain('[truncated]');
  });

  it.each(['AIza' + 'a'.repeat(35), 'or-' + 'b'.repeat(32), 'custom-private-key-value'])(
    'redacts provider keys from version diagnostics: %s',
    async (secret) => {
      execCli.mockRejectedValueOnce(
        Object.assign(new Error('version failed'), {
          stderr: JSON.stringify({ key: secret }),
          stdout: secret.startsWith('custom') ? `key=${secret}` : secret,
        })
      );
      const result = await probeOpenCodeBinaryVersion('/test/opencode');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain('[redacted]');
    }
  );

  it.each([
    'Error: api_key=custom-private-key-value',
    'Authorization: Bearer custom-private-key-value',
    'Cookie: a=public; session=custom-private-key-value',
    '{"auth":{"key":"custom-private-key-value"}}',
  ])('redacts credentials nested in diagnostic text: %s', async (stderr) => {
    execCli.mockRejectedValueOnce(Object.assign(new Error('version failed'), { stderr }));
    const result = await probeOpenCodeBinaryVersion('/test/opencode');
    expect(JSON.stringify(result)).not.toContain('custom-private-key-value');
    expect(JSON.stringify(result)).toContain('[redacted]');
  });

  it.each([
    [
      'timeout',
      Object.assign(new Error('Command timed out after 30000ms: /tmp/opencode --version'), {
        killed: true,
        signal: 'SIGTERM',
        stderr: 'waiting',
      }),
      true,
      null,
    ],
    [
      'abort',
      Object.assign(new Error('Command aborted: /tmp/opencode --version'), {
        killed: true,
        signal: 'SIGTERM',
      }),
      false,
      null,
    ],
    [
      'exit',
      Object.assign(new Error('Command failed'), { code: 9, stderr: 'api_key=private-value' }),
      false,
      9,
    ],
    ['missing', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), false, null],
  ])(
    'preserves the %s outcome without conflating kills with timeouts',
    async (_name, error, timedOut, exitCode) => {
      execCli.mockRejectedValueOnce(error);
      const result = await probeOpenCodeBinaryVersion('/tmp/opencode');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected failure');
      expect(result.diagnostics).toMatchObject({
        stage: 'version_probe',
        binaryRole: 'opencode',
        timedOut,
        exitCode,
        timeoutMs: 30000,
      });
      expect(result.diagnostics.reportId).toBeTruthy();
      expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(result)).not.toContain('private-value');
    }
  );
});
