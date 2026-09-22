import type {
  RespondToToolApprovalCommand,
  TeamProvisioningToolApprovalApi,
  UpdateToolApprovalSettingsCommand,
} from '../../../contracts/tool-approval';
import type { ToolApprovalPort } from '../../../core/application/ports/ToolApprovalPort';

export type LegacyToolApprovalSource = TeamProvisioningToolApprovalApi;

export class LegacyToolApprovalAdapter implements ToolApprovalPort {
  constructor(private readonly source: LegacyToolApprovalSource) {}

  respondToToolApproval(command: RespondToToolApprovalCommand): Promise<void> {
    return this.source.respondToToolApproval(
      command.teamName,
      command.runId,
      command.requestId,
      command.allow,
      command.message
    );
  }

  updateToolApprovalSettings(command: UpdateToolApprovalSettingsCommand): void {
    this.source.updateToolApprovalSettings(command.teamName, command.settings);
  }
}
