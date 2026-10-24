import { ManagementCommandError } from './commandRecords.js';

import type { StoredManagementCommand } from './commandRecords.js';

/** OAuth, credential writes and model probes share one admission per native auth namespace. */
export class ManagementResourceFence {
  private readonly held = new Set<string>();
  private readonly active = new Map<string, string>();

  constructor(records: Iterable<StoredManagementCommand>) {
    for (const saved of records) if (saved.resourceHeld) this.held.add(saved.resourceId);
  }

  reserve(resourceId: string, commandId: string): void {
    if (this.held.has(resourceId)) throw new ManagementCommandError('held');
    if (this.active.has(resourceId)) throw new ManagementCommandError('busy');
    this.active.set(resourceId, commandId);
  }

  release(resourceId: string, commandId: string, settled: boolean): void {
    // A late response from a retired flow cannot release or poison its replacement.
    if (this.active.get(resourceId) !== commandId) return;
    if (!settled) this.held.add(resourceId);
    this.active.delete(resourceId);
  }
}
