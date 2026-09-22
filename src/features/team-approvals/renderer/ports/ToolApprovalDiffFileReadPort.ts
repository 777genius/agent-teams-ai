import type { ToolApprovalFileReadRequest } from '../../contracts';
import type { ToolApprovalFileContent } from '@shared/types';

export interface ToolApprovalDiffFileReadPort {
  readFile(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent>;
}
