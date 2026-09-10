import { randomUUID } from 'node:crypto';

import { execCli } from '@main/utils/childProcess';
import { APP_VERSION } from '@shared/utils/buildMetadata';
import { createLogger } from '@shared/utils/logger';

import { cleanRuntimeDiagnosticText, runtimeErrorDetailRows } from '../../contracts';

import type { RuntimeProviderManagementErrorDto } from '../../contracts';

const logger = createLogger('OpenCodeCatalog');

/** One actual catalog attempt, owned by the existing in-flight promise. */
export class RuntimeProviderCatalogDiagnostics {
  private command: string | null = null;
  private binaryPath: string | null = null;
  private durationMs?: number;
  private timeoutMs?: number;
  private exitCode: number | null = null;
  private timedOut = false;
  private signal?: string;
  private systemErrorCode?: string;
  private stderr: string | null = null;
  private finalized?: RuntimeProviderManagementErrorDto;

  constructor(
    private readonly operation: 'provider_directory' | 'provider_models',
    private readonly projectPath: string | null,
    private readonly sourceProviderId: string | null = null
  ) {}

  readonly exec: typeof execCli = async (binaryPath, args, options = {}) => {
    this.exitCode = null;
    this.signal = undefined;
    this.systemErrorCode = undefined;
    this.timedOut = false;
    this.stderr = null;
    this.binaryPath = binaryPath;
    this.command = args.join(' ');
    this.timeoutMs = typeof options.timeout === 'number' ? options.timeout : undefined;
    const started = performance.now();
    try {
      const result = await execCli(binaryPath, args, options);
      this.exitCode = 0;
      this.stderr = result.stderr;
      return result;
    } catch (error) {
      const raw = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      this.exitCode = typeof raw.code === 'number' && Number.isInteger(raw.code) ? raw.code : null;
      this.signal = typeof raw.signal === 'string' ? raw.signal : undefined;
      this.systemErrorCode = typeof raw.code === 'string' ? raw.code : undefined;
      this.stderr = typeof raw.stderr === 'string' ? raw.stderr : null;
      this.timedOut =
        !options.signal?.aborted &&
        error instanceof Error &&
        error.message.startsWith(`Command timed out after ${this.timeoutMs}ms:`);
      throw error;
    } finally {
      this.durationMs = Math.round(performance.now() - started);
    }
  };

  finish<T extends { error?: RuntimeProviderManagementErrorDto | null }>(response: T): T {
    if (!response.error) return response;
    if (this.finalized) return { ...response, error: this.finalized };
    const previous = response.error.diagnostics;
    const clean = cleanRuntimeDiagnosticText;
    const message = clean(response.error.message) ?? 'Catalog request failed.';
    const diagnostics = {
      schemaVersion: 1 as const,
      reportId: `oc-${randomUUID().replaceAll('-', '')}`,
      ...(previous?.reportId ? { upstreamReportId: clean(previous.reportId, 256)! } : {}),
      timestamp: new Date().toISOString(),
      appVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      stage: this.command ? ('runtime_command' as const) : ('binary_lookup' as const),
      binaryRole: 'orchestrator' as const,
      binarySource: 'unknown' as const,
      ...(this.command
        ? {
            durationMs: this.durationMs,
            timeoutMs: this.timeoutMs,
            timedOut: this.timedOut,
            signal: clean(this.signal, 256) ?? undefined,
            systemErrorCode: clean(this.systemErrorCode, 256) ?? undefined,
          }
        : {}),
      errorCode: response.error.code,
      summary: message,
      likelyCause: clean(previous?.likelyCause),
      binaryPath: clean(this.binaryPath ?? previous?.binaryPath),
      command: clean(this.command),
      projectPath: clean(this.projectPath),
      exitCode: this.exitCode,
      stderrPreview: clean(this.stderr),
      stdoutPreview: null,
      hints: previous
        ? [
            ...[
              ['summary', previous.summary],
              ['stderr', previous.stderrPreview],
              ['stdout', previous.stdoutPreview],
            ]
              .filter(([, value]) => value)
              .map(([key, value]) => `Runtime hint ${key}: ${value}`),
            ...runtimeErrorDetailRows(previous)
              .filter(([key]) =>
                ['stage', 'cause', 'httpMethod', 'endpoint', 'httpStatus'].includes(key)
              )
              .map(([key, value]) => `Runtime hint ${key}: ${value}`),
            ...(previous.hints ?? []).map((hint) => `Runtime hint: ${hint}`),
          ]
            .slice(0, 8)
            .map((hint) => clean(hint, 512)!)
        : [],
    };
    this.finalized = {
      code: response.error.code,
      recoverable: response.error.recoverable,
      message,
      diagnostics,
    };
    try {
      logger.warn(`OpenCode catalog ${this.operation} failed, report ${diagnostics.reportId}`, {
        sourceProviderId: clean(this.sourceProviderId, 256),
        message,
        diagnostics,
      });
    } catch {
      /* Logging cannot replace the catalog response. */
    }
    return { ...response, error: this.finalized };
  }
}
