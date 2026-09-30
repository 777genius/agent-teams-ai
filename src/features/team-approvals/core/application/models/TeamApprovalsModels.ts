export type ToolApprovalTimeoutAction = 'allow' | 'deny' | 'wait';

/** Settings consumed by the approvals use cases, independent of the shared UI DTO barrel. */
export interface ToolApprovalSettings {
  autoAllowAll: boolean;
  autoAllowFileEdits: boolean;
  autoAllowSafeBash: boolean;
  timeoutAction: ToolApprovalTimeoutAction;
  timeoutSeconds: number;
}

/** File preview returned by the feature-owned approval reader port. */
export interface ToolApprovalFileContent {
  content: string;
  exists: boolean;
  truncated: boolean;
  isBinary: boolean;
  error?: string;
}
