import * as fs from 'fs';

interface FatalDiagnosticReportTarget {
  reportOnFatalError?: boolean;
  directory?: string;
  compact?: boolean;
}

interface FatalDiagnosticReportLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ConfigureFatalDiagnosticReportResult {
  enabled: boolean;
  directory?: string;
  reason?: string;
}

export function configureFatalDiagnosticReport(options: {
  directory: string;
  report?: FatalDiagnosticReportTarget | null;
  mkdirSync?: typeof fs.mkdirSync;
  logger?: FatalDiagnosticReportLogger;
}): ConfigureFatalDiagnosticReportResult {
  const report = 'report' in options ? options.report : process.report;
  if (!report) {
    return { enabled: false, reason: 'process_report_unavailable' };
  }

  try {
    (options.mkdirSync ?? fs.mkdirSync)(options.directory, { recursive: true });
    report.directory = options.directory;
    report.reportOnFatalError = true;
    if ('compact' in report) {
      report.compact = true;
    }
    options.logger?.info(`[diagnostics] fatal diagnostic reports enabled dir=${options.directory}`);
    return { enabled: true, directory: options.directory };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.logger?.warn(`[diagnostics] fatal diagnostic reports unavailable: ${reason}`);
    return { enabled: false, reason };
  }
}
