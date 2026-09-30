import type { RuntimeProviderManagementErrorDiagnosticsDto } from '../../contracts';

export interface OpenCodeVersionCommandResult {
  stdout: string;
}

export interface OpenCodeVersionCommandOptions {
  timeout: number;
  windowsHide: boolean;
}

export interface OpenCodeVersionDiagnosticMetadata {
  appVersion: string;
  platform: string;
  arch: string;
}

/** Host capabilities required by the OpenCode version diagnostic use case. */
export interface OpenCodeVersionDiagnosticPorts {
  execute(
    binaryPath: string,
    args: readonly string[],
    options: OpenCodeVersionCommandOptions
  ): Promise<OpenCodeVersionCommandResult>;
  createReportId(): string;
  monotonicNow(): number;
  timestampNow(): string;
  metadata(): OpenCodeVersionDiagnosticMetadata;
  warn(message: string, diagnostics: RuntimeProviderManagementErrorDiagnosticsDto): void;
}
