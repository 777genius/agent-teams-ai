import type { JsonValue } from '../contracts.js';

/** Trusted member composition captures the original authenticated input before any await. */
export interface TeamMcpWorkSyncPort {
  status(commandId: string, input: { forceNudge?: boolean }): Promise<JsonValue>;
  report(
    commandId: string,
    input: {
      state: 'still_working' | 'blocked' | 'caught_up';
      agendaFingerprint: string;
      reportToken: string;
      taskIds?: string[];
      note?: string;
      leaseTtlMs?: number;
    }
  ): Promise<JsonValue>;
}
