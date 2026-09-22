import {
  createRetentionBudget,
  parseDiagnosticId,
  parseOperationalReferenceId,
  parseOperationCorrelationId,
} from '../../contracts';
import { snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';
import { BoundedHostedDiagnosticsReferenceStore } from '../adapters/output/BoundedHostedDiagnosticsReferenceStore';
import { createNodeHostedDiagnosticsPlatform } from '../infrastructure/NodeHostedDiagnosticsPlatform';

import type { OperationalReferenceId, RetentionBudget } from '../../contracts';
import type { DiagnosticIdGeneratorPort } from '../../core/application/ports';
import type {
  HostedDiagnosticsCorrelationIdPort,
  HostedDiagnosticsDeadlineSchedulerPort,
  HostedDiagnosticsSourcePort,
  HostedDiagnosticsSourceRecord,
} from '../../core/application/ports/HostedDiagnosticsPorts';
import type { QueryContext } from '@shared/contracts/hosted';

const OPAQUE_IDENTIFIER_BYTES = 16;

export const HOSTED_DIAGNOSTICS_RETENTION_BUDGET: RetentionBudget = createRetentionBudget({
  maxEntries: 256,
  maxAgeMs: 10 * 60 * 1_000,
  maxTotalBytes: 512 * 1_024,
});

/** The only public mutation port for process-local hosted diagnostic references. */
export interface HostedDiagnosticsRecorderPort {
  record(value: HostedDiagnosticsSourceRecord, context: QueryContext): OperationalReferenceId;
}

export interface CreateHostedDiagnosticsAdaptersOptions {
  readonly retentionBudget?: RetentionBudget;
}

export interface HostedDiagnosticsAdapters {
  readonly source: HostedDiagnosticsSourcePort;
  readonly recorder: HostedDiagnosticsRecorderPort;
  readonly diagnosticIds: DiagnosticIdGeneratorPort;
  readonly correlationIds: HostedDiagnosticsCorrelationIdPort;
  readonly deadlineScheduler: HostedDiagnosticsDeadlineSchedulerPort;
  close(): void;
}

function createOpaqueIdentifier(
  platform: ReturnType<typeof createNodeHostedDiagnosticsPlatform>,
  prefix: 'diagnostic' | 'reference' | 'request'
): string {
  try {
    const bytes = platform.randomBytes(OPAQUE_IDENTIFIER_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== OPAQUE_IDENTIFIER_BYTES) {
      throw new TypeError('hosted-diagnostics-random-invalid');
    }
    return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    throw new TypeError('hosted-diagnostics-random-invalid');
  }
}

function parseRetentionBudget(value: unknown): RetentionBudget {
  return createRetentionBudget(value as RetentionBudget);
}

function createDeadlineScheduler(
  platform: ReturnType<typeof createNodeHostedDiagnosticsPlatform>
): HostedDiagnosticsDeadlineSchedulerPort {
  return Object.freeze({
    nowMs(): number {
      const nowMs = platform.nowEpochMs();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('hosted-diagnostics-deadline-clock-invalid');
      }
      return nowMs;
    },
    schedule(delayMs: number, onDeadline: () => void): () => void {
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || typeof onDeadline !== 'function') {
        throw new TypeError('hosted-diagnostics-deadline-scheduler-invalid');
      }
      let active = true;
      let cancelPlatformTimer: (() => void) | undefined;
      try {
        cancelPlatformTimer = platform.schedule(delayMs, () => {
          if (!active) return;
          active = false;
          onDeadline();
        });
      } catch {
        active = false;
        throw new TypeError('hosted-diagnostics-deadline-scheduler-invalid');
      }
      if (typeof cancelPlatformTimer !== 'function') {
        active = false;
        throw new TypeError('hosted-diagnostics-deadline-scheduler-invalid');
      }
      return () => {
        if (!active) return;
        active = false;
        cancelPlatformTimer();
      };
    },
  });
}

/** Creates one bounded registry whose references exist only for this adapter-set lifetime. */
export function createHostedDiagnosticsAdapters(
  options: CreateHostedDiagnosticsAdaptersOptions = {}
): HostedDiagnosticsAdapters {
  const input = snapshotExactDataRecord(
    options,
    [],
    'hosted-diagnostics-adapters-options-invalid',
    { optionalKeys: ['retentionBudget'] }
  );
  const retentionBudget =
    input.retentionBudget === undefined
      ? HOSTED_DIAGNOSTICS_RETENTION_BUDGET
      : parseRetentionBudget(input.retentionBudget);
  const platform = createNodeHostedDiagnosticsPlatform();
  const store = new BoundedHostedDiagnosticsReferenceStore({
    platform,
    retentionBudget,
    generateReferenceId: () =>
      parseOperationalReferenceId(createOpaqueIdentifier(platform, 'reference')),
  });

  return Object.freeze({
    source: store,
    recorder: store,
    diagnosticIds: Object.freeze({
      generateDiagnosticId: () => parseDiagnosticId(createOpaqueIdentifier(platform, 'diagnostic')),
    }),
    correlationIds: Object.freeze({
      resolveCorrelationId: () =>
        parseOperationCorrelationId(createOpaqueIdentifier(platform, 'request')),
    }),
    deadlineScheduler: createDeadlineScheduler(platform),
    close: () => store.close(),
  });
}
