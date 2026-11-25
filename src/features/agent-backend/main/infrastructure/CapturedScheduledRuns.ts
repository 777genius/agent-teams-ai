import { scheduledRunInputSchema, scheduledRunSnapshotSchema } from '@agent-teams/legacy-agent-host/scheduled-runs';

import { BackendRoutingError } from '../application/backendBinding';

import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { ScheduledRunInput, ScheduledRunSnapshot } from '@agent-teams/legacy-agent-host/scheduled-runs';

/** Private Main scheduler port. Lost replies only read the same original run; no implicit rerun. */
export class CapturedScheduledRuns {
  constructor(private readonly request: (operation: 'start' | 'read' | 'cancel',
    runId: string, payload: JsonValue) => Promise<JsonValue>, private readonly scheduleId: string) {}

  private async call(operation: 'start' | 'read' | 'cancel', runId: string, payload: JsonValue) {
    const response = await this.request(operation, runId, payload);
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.ok !== true)
      throw new BackendRoutingError('hold');
    if (response.value === null && operation === 'read') return null;
    const snapshot = scheduledRunSnapshotSchema.parse(response.value);
    if (snapshot.runId !== runId) throw new BackendRoutingError('invalid-binding');
    return snapshot;
  }

  read(runId: string): Promise<ScheduledRunSnapshot | null> {
    return this.call('read', runId, { runId, scheduleId: this.scheduleId });
  }
  async start(input: ScheduledRunInput): Promise<ScheduledRunSnapshot> {
    const selected = scheduledRunInputSchema.parse(structuredClone(input));
    if (selected.scheduleId !== this.scheduleId) throw new BackendRoutingError('invalid-binding');
    try {
      const result = await this.call('start', selected.runId, selected as JsonValue);
      if (!result) throw new BackendRoutingError('hold');
      return result;
    } catch (error) {
      const original = await this.read(selected.runId);
      if (original) return original;
      throw error;
    }
  }
  async cancel(runId: string): Promise<ScheduledRunSnapshot> {
    const result = await this.call('cancel', runId, { runId, scheduleId: this.scheduleId });
    if (!result) throw new BackendRoutingError('hold');
    return result;
  }
}
