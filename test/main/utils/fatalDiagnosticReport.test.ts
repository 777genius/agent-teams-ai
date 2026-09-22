import { describe, expect, it, vi } from 'vitest';

import { configureFatalDiagnosticReport } from '../../../src/main/utils/fatalDiagnosticReport';

describe('fatalDiagnosticReport', () => {
  it('enables compact fatal diagnostic reports in the requested directory', () => {
    const report = {
      reportOnFatalError: false,
      directory: '',
      compact: false,
    };
    const mkdirSync = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const result = configureFatalDiagnosticReport({
      directory: '/tmp/agent-teams-diagnostics',
      report,
      mkdirSync: mkdirSync as never,
      logger,
    });

    expect(result).toEqual({
      enabled: true,
      directory: '/tmp/agent-teams-diagnostics',
    });
    expect(mkdirSync).toHaveBeenCalledWith('/tmp/agent-teams-diagnostics', { recursive: true });
    expect(report).toEqual({
      reportOnFatalError: true,
      directory: '/tmp/agent-teams-diagnostics',
      compact: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[diagnostics] fatal diagnostic reports enabled dir=/tmp/agent-teams-diagnostics'
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is a no-op when process reports are unavailable', () => {
    const result = configureFatalDiagnosticReport({
      directory: '/tmp/agent-teams-diagnostics',
      report: null,
    });

    expect(result).toEqual({
      enabled: false,
      reason: 'process_report_unavailable',
    });
  });

  it('returns a disabled result when the diagnostics directory cannot be created', () => {
    const report = {
      reportOnFatalError: false,
      directory: '',
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const result = configureFatalDiagnosticReport({
      directory: '/tmp/agent-teams-diagnostics',
      report,
      mkdirSync: vi.fn(() => {
        throw new Error('permission denied');
      }) as never,
      logger,
    });

    expect(result).toEqual({
      enabled: false,
      reason: 'permission denied',
    });
    expect(report).toEqual({
      reportOnFatalError: false,
      directory: '',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[diagnostics] fatal diagnostic reports unavailable: permission denied'
    );
  });
});
