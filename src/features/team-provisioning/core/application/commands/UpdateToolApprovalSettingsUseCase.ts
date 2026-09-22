import type { UpdateToolApprovalSettingsCommand } from '../../../contracts/tool-approval';
import type { ToolApprovalSettingsPort } from '../ports/ToolApprovalPort';

export class UpdateToolApprovalSettingsUseCase {
  constructor(private readonly toolApproval: ToolApprovalSettingsPort) {}

  execute(command: UpdateToolApprovalSettingsCommand): void {
    this.toolApproval.updateToolApprovalSettings(command);
  }
}
