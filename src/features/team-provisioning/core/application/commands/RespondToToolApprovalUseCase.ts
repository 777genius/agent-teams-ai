import type { RespondToToolApprovalCommand } from '../../../contracts/tool-approval';
import type { ToolApprovalResponsePort } from '../ports/ToolApprovalPort';

export class RespondToToolApprovalUseCase {
  constructor(private readonly toolApproval: ToolApprovalResponsePort) {}

  execute(command: RespondToToolApprovalCommand): Promise<void> {
    return this.toolApproval.respondToToolApproval(command);
  }
}
