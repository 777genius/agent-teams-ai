/** Push event: tool approval request or dismissal (main -> renderer). */
export const TEAM_TOOL_APPROVAL_EVENT = 'team:toolApprovalEvent';

/** Invoke: respond to a tool approval request (renderer -> main). */
export const TEAM_TOOL_APPROVAL_RESPOND = 'team:toolApprovalRespond';

/** Invoke: update tool approval settings (renderer -> main). */
export const TEAM_TOOL_APPROVAL_SETTINGS = 'team:toolApprovalSettings';

/** Invoke: read file content for the tool approval diff preview (renderer -> main). */
export const TEAM_TOOL_APPROVAL_READ_FILE = 'team:toolApprovalReadFile';
