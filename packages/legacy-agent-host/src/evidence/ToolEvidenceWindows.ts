import type { EvidenceWorkspace } from './bindRuntimeInputEvidence.js';
export interface SharedEvidenceWindow {
  readonly binding: { readonly workspace: Readonly<EvidenceWorkspace> };
  invalidReason?: string;
  readonly warnings: Set<string>;
}

/** One Host-composed instance shared across member captures; no process/global state. */
export class ToolEvidenceWindows {
  private readonly active = new Map<string, SharedEvidenceWindow>();
  add(key: string, window: SharedEvidenceWindow): boolean {
    if (this.active.has(key) || this.active.size >= 80) return false;
    for (const other of this.active.values()) {
      if (
        other.binding.workspace.path === window.binding.workspace.path ||
        other.binding.workspace.identity === window.binding.workspace.identity
      ) {
        other.invalidReason = 'overlapping-windows';
        window.invalidReason = 'overlapping-windows';
        other.warnings.add('Overlapping native tool intervals; authorship is uncertain.');
        window.warnings.add('Overlapping native tool intervals; authorship is uncertain.');
      }
    }
    this.active.set(key, window);
    return true;
  }
  remove(key: string, window: SharedEvidenceWindow): void {
    if (this.active.get(key) === window) this.active.delete(key);
  }
}
