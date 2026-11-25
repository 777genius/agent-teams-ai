import { hostTeamSelectionKey, isHostTeamSelectionKey } from '@features/agent-backend/contracts/teamSelection';

import type { AttentionSourcePort, AttentionTeamSource } from '../../../core/application/ports';
import type { CapturedHostTeamReads } from '@features/agent-backend/main';

/** Request-local routing: Host destinations never enter the legacy filesystem readers. */
export class HostRoutedAttentionSource implements AttentionSourcePort {
  private readonly failures = new Map<string, unknown>();

  constructor(private readonly legacy: AttentionSourcePort,
    private readonly host: CapturedHostTeamReads | undefined) {}

  currentContextId(): string {
    this.host?.assertCurrent();
    return this.legacy.currentContextId();
  }

  async listTeams(): Promise<readonly AttentionTeamSource[]> {
    const legacy = (await this.legacy.listTeams()).filter(row => !isHostTeamSelectionKey(row.teamName));
    if (!this.host) return legacy;
    this.host.assertCurrent();
    const rows = new Map<string, AttentionTeamSource>();
    const parents = new Map<string, string>();
    const deleted = new Set<string>();
    for (const binding of this.host.bindings) {
      const selection = hostTeamSelectionKey(binding.handle.handleId);
      const fallback = { teamName: selection, displayName: binding.label,
        ...(binding.projectContext ? { projectPath: binding.projectContext.projectPath } : {}) };
      try {
        const logical = this.host.logicalConnection(binding);
        if (logical.handle.handleId !== binding.handle.handleId)
          parents.set(selection, hostTeamSelectionKey(logical.handle.handleId));
        const { data, assertCurrent } = await this.host.product(selection);
        if (data.lifecycle?.deletedAt) { deleted.add(selection); continue; }
        const saved = await this.host.savedConfiguration(selection);
        if (data.configurationRevision !== undefined &&
          data.configurationRevision !== saved.configuration.revision)
          throw new Error('Host attention configuration changed');
        const projectPath = binding.projectContext?.projectPath ?? saved.configuration.savedSettings?.cwd;
        rows.set(selection, { ...fallback,
          ...(projectPath ? { projectPath } : {}),
          directParticipants: data.members.map(member => member.name),
          leadName: data.members.find(member => member.role === 'lead')?.name,
        });
        assertCurrent();
        saved.assertCurrent();
      } catch (error) {
        this.host.assertCurrent();
        this.failures.set(selection, error);
        rows.set(selection, fallback);
      }
    }
    for (const [child, parent] of parents) {
      if (deleted.has(parent)) { rows.delete(child); continue; }
      const childRow = rows.get(child), parentRow = rows.get(parent);
      if (!childRow || !parentRow || !childRow.projectPath) continue;
      parentRow.projectHistoryContexts = [...(parentRow.projectHistoryContexts ?? []), {
        executionTeamName: child, projectPath: childRow.projectPath,
        directParticipants: childRow.directParticipants, leadName: childRow.leadName,
      }];
      rows.delete(child);
    }
    this.host.assertCurrent();
    return [...legacy, ...rows.values()];
  }

  private selected(selection: string): CapturedHostTeamReads {
    if (!this.host) throw new Error('Host attention source unavailable');
    this.host.connection(selection);
    if (this.failures.has(selection)) throw this.failures.get(selection);
    return this.host;
  }

  async listHumanTasks(selection: string) {
    if (!isHostTeamSelectionKey(selection)) return this.legacy.listHumanTasks(selection);
    const result = await this.selected(selection).product(selection);
    result.assertCurrent();
    return result.data.tasks;
  }

  async listNormalizedMessages(selection: string) {
    if (!isHostTeamSelectionKey(selection)) return this.legacy.listNormalizedMessages(selection);
    const result = await this.selected(selection).product(selection);
    result.assertCurrent();
    return result.data.messages;
  }

  async listGroupNames(selection: string): Promise<Record<string, string>> {
    if (!isHostTeamSelectionKey(selection)) return this.legacy.listGroupNames?.(selection) ?? {};
    return this.selected(selection).groupNames(selection);
  }
}
