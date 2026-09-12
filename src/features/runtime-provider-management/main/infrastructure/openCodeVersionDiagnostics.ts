import { randomUUID } from 'node:crypto';

import { execCli } from '@main/utils/childProcess';
import { APP_VERSION } from '@shared/utils/buildMetadata';
import { createLogger } from '@shared/utils/logger';

import { cleanRuntimeDiagnosticText } from '../../contracts';

import type { RuntimeProviderManagementErrorDiagnosticsDto } from '../../contracts';

const logger = createLogger('OpenCodeVersionDiagnostics');
const VERSION_TIMEOUT_MS = 30_000;

export type OpenCodeBinaryVersionProbe =
  | { ok: true; version: string | null }
  | { ok: false; error: string; diagnostics: RuntimeProviderManagementErrorDiagnosticsDto };

export interface OpenCodeBinaryCandidateFailure {
  binaryPath: string;
  error: string;
  diagnostics?: RuntimeProviderManagementErrorDiagnosticsDto;
}

export async function probeOpenCodeBinaryVersion(
  binaryPath: string
): Promise<OpenCodeBinaryVersionProbe> {
  const started = performance.now();
  try {
    const { stdout } = await execCli(binaryPath, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, version: stdout.trim() || null };
  } catch (error) {
    const raw = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const message =
      cleanRuntimeDiagnosticText(error instanceof Error ? error.message : String(error)) ??
      'OpenCode version check failed';
    const diagnostics: RuntimeProviderManagementErrorDiagnosticsDto = {
      schemaVersion: 1,
      reportId: `oc-${randomUUID().replaceAll('-', '')}`,
      timestamp: new Date().toISOString(),
      appVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      stage: 'version_probe',
      binaryRole: 'opencode',
      durationMs: Math.round(performance.now() - started),
      timeoutMs: VERSION_TIMEOUT_MS,
      timedOut:
        error instanceof Error &&
        error.message.startsWith(`Command timed out after ${VERSION_TIMEOUT_MS}ms:`),
      ...(typeof raw.signal === 'string' ? { signal: raw.signal } : {}),
      ...(typeof raw.code === 'string' ? { systemErrorCode: raw.code } : {}),
      summary: message,
      likelyCause: null,
      binaryPath: cleanRuntimeDiagnosticText(binaryPath),
      command: '--version',
      projectPath: null,
      exitCode: typeof raw.code === 'number' && Number.isInteger(raw.code) ? raw.code : null,
      stderrPreview: cleanRuntimeDiagnosticText(raw.stderr),
      stdoutPreview: cleanRuntimeDiagnosticText(raw.stdout),
      hints: [],
    };
    logger.warn(`OpenCode version probe failed, report ${diagnostics.reportId}`, diagnostics);
    return { ok: false, error: message, diagnostics };
  }
}
