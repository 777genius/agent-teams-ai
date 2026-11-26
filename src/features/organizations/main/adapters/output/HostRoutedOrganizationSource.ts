import { hostTeamSelectionKey, isHostTeamSelectionKey } from '@features/agent-backend/contracts';

import type {
  OrganizationsCrossTeamMessagePort,
  OrganizationsTeamDirectoryPort,
} from '../../../core/application';
import type { CrossTeamMessageCandidate, OrgTeamCandidate } from '../../../core/domain';
import type { BackendTeamSnapshot } from '@features/agent-backend/contracts';
import type { CapturedHostTeamReads } from '@features/agent-backend/main';

/** One original request catalog. Host selection keys never enter a legacy directory/outbox. */
export class HostRoutedOrganizationSource
  implements OrganizationsTeamDirectoryPort, OrganizationsCrossTeamMessagePort
{
  private failure?: Error;
  constructor(
    private readonly host: CapturedHostTeamReads,
    private readonly legacyDirectory: OrganizationsTeamDirectoryPort,
    private readonly legacyMessages: OrganizationsCrossTeamMessagePort
  ) {}

  assertCurrent(): void {
    this.host.assertCurrent();
    if (this.host.unavailableOwners.length)
      throw new Error('Original organization Host catalog is incomplete');
    if (this.failure) throw this.failure;
  }

  private async capture<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    try {
      const result = await operation();
      this.assertCurrent();
      return result;
    } catch (error) {
      this.failure ??=
        error instanceof Error
          ? error
          : new Error('Original organization request failed', { cause: error });
      throw error;
    }
  }

  async listTeams(input: { includeDeletedTeams: boolean }): Promise<OrgTeamCandidate[]> {
    return this.capture(async () => {
      const legacy = await this.legacyDirectory.listTeams(input);
      this.assertCurrent();
      if (legacy.some((row) => isHostTeamSelectionKey(row.teamName)))
        throw new Error('Host organization identity appeared in the legacy directory');
      const products = new Map<string, BackendTeamSnapshot>();
      for (const binding of this.host.bindings) {
        const selection = hostTeamSelectionKey(binding.handle.handleId);
        this.host.logicalConnection(binding);
        const product = await this.host.product(selection);
        product.assertCurrent();
        if (
          product.data.lifecycle?.pendingPurge ||
          product.data.lifecycle?.pendingChange ||
          product.data.lifecycle?.cleanupPending
        )
          throw new Error('Original organization team lifecycle is pending');
        products.set(selection, product.data);
      }
      const teams: OrgTeamCandidate[] = [];
      for (const binding of this.host.bindings) {
        if (binding.projectContext) continue;
        const selection = hostTeamSelectionKey(binding.handle.handleId);
        const product = products.get(selection)!;
        const deletedAt = product.lifecycle?.deletedAt ?? undefined;
        if (deletedAt && !input.includeDeletedTeams) continue;
        const saved = deletedAt ? undefined : await this.host.savedConfiguration(selection);
        if (saved && product.configurationRevision !== saved.configuration.revision)
          throw new Error('Original organization team settings changed');
        const configuration = saved?.configuration;
        const members =
          configuration?.members.map((member) => ({
            name: member.name,
            role: member.role === 'lead' ? 'Lead' : member.settings.role,
          })) ?? product.members.map((member) => ({ name: member.name, role: member.role }));
        const histories = this.host.bindings.filter(
          (row) =>
            row.projectContext &&
            this.host.logicalConnection(row).handle.handleId === binding.handle.handleId
        );
        const sources = [binding, ...histories].map((row) => ({
          selection: hostTeamSelectionKey(row.handle.handleId),
          data: products.get(hostTeamSelectionKey(row.handle.handleId))!,
        }));
        teams.push({
          teamName: selection,
          displayName: binding.label,
          description: configuration?.savedSettings?.description,
          color: configuration?.savedSettings?.color,
          projectPath: configuration?.savedSettings?.cwd,
          deletedAt,
          isOnline: sources.some(
            (row) =>
              !row.data.lifecycle?.deletedAt &&
              row.data.processes?.some(
                (process) => process.observation === 'same-live' && !process.stoppedAt
              )
          ),
          members,
          tasks: sources
            .filter((row) => input.includeDeletedTeams || !row.data.lifecycle?.deletedAt)
            .flatMap((row) =>
              row.data.tasks.map((task) => ({
                id: task.id,
                subject: task.subject,
                owner: task.owner,
                status: task.status,
                updatedAt: task.updatedAt,
                kanbanColumn: task.kanbanColumn,
                ...(row.selection === selection ? {} : { executionTeamName: row.selection }),
              }))
            ),
        });
        saved?.assertCurrent();
      }
      return [...legacy, ...teams];
    });
  }

  async listRecentMessages(input: {
    teamNames: readonly string[];
    maxMessages: number;
  }): Promise<CrossTeamMessageCandidate[]> {
    return this.capture(async () => {
      const visible = new Set(input.teamNames);
      const messages = await this.legacyMessages.listRecentMessages({
        ...input,
        teamNames: input.teamNames.filter((name) => !isHostTeamSelectionKey(name)),
      });
      this.assertCurrent();
      const seen = new Set<string>();
      for (const binding of this.host.bindings) {
        const logical = this.host.logicalConnection(binding);
        if (!visible.has(hostTeamSelectionKey(logical.handle.handleId))) continue;
        const product = await this.host.product(hostTeamSelectionKey(binding.handle.handleId));
        for (const message of product.data.messages) {
          const origin = message.crossTeamOrigin;
          if (!origin) continue;
          const from = this.host.bindings.find(
            (row) => row.handle.handleId === origin.fromHandleId
          );
          const to = this.host.bindings.find((row) => row.handle.handleId === origin.toHandleId);
          // Historical/headless origins may not be in this captured catalog. Never join by label.
          if (
            !from ||
            !to ||
            to.handle.handleId !== binding.handle.handleId ||
            from.teamResourceRef !== origin.fromTeamResourceRef ||
            to.teamResourceRef !== origin.toTeamResourceRef
          )
            continue;
          const fromTeam = hostTeamSelectionKey(this.host.logicalConnection(from).handle.handleId);
          const toTeam = hostTeamSelectionKey(this.host.logicalConnection(to).handle.handleId);
          if (fromTeam === toTeam || !visible.has(fromTeam) || !visible.has(toTeam)) continue;
          const key = JSON.stringify([
            origin.fromTeamResourceRef,
            origin.toTeamResourceRef,
            message.messageId,
            message.timestamp,
            message.text,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push({
            fromTeam,
            toTeam,
            messageId: message.messageId,
            text: message.text,
            summary: message.summary,
            conversationId: message.conversationId,
            timestamp: message.timestamp,
          });
        }
        product.assertCurrent();
      }
      return messages
        .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
        .slice(0, input.maxMessages);
    });
  }
}
