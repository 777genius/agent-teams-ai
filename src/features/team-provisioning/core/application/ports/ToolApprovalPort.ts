import type {
  RespondToToolApprovalCommand,
  UpdateToolApprovalSettingsCommand,
} from '../../../contracts/tool-approval';

export interface ToolApprovalResponsePort {
  respondToToolApproval(command: RespondToToolApprovalCommand): Promise<void>;
}

export interface ToolApprovalSettingsPort {
  updateToolApprovalSettings(command: UpdateToolApprovalSettingsCommand): void;
}

export interface ToolApprovalPort extends ToolApprovalResponsePort, ToolApprovalSettingsPort {}
