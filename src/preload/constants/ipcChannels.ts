/**
 * IPC Channel Constants
 *
 * Centralized IPC channel names to avoid string duplication in preload bridge.
 */

// =============================================================================
// Config API Channels
// =============================================================================

/** Get application config */
export const CONFIG_GET = 'config:get';

/** Update config section */
export const CONFIG_UPDATE = 'config:update';

/** Add regex pattern to ignore list */
export const CONFIG_ADD_IGNORE_REGEX = 'config:addIgnoreRegex';

/** Remove regex pattern from ignore list */
export const CONFIG_REMOVE_IGNORE_REGEX = 'config:removeIgnoreRegex';

/** Add repository to ignore list */
export const CONFIG_ADD_IGNORE_REPOSITORY = 'config:addIgnoreRepository';

/** Remove repository from ignore list */
export const CONFIG_REMOVE_IGNORE_REPOSITORY = 'config:removeIgnoreRepository';

/** Snooze notifications */
export const CONFIG_SNOOZE = 'config:snooze';

/** Clear notification snooze */
export const CONFIG_CLEAR_SNOOZE = 'config:clearSnooze';

/** Add notification trigger */
export const CONFIG_ADD_TRIGGER = 'config:addTrigger';

/** Update notification trigger */
export const CONFIG_UPDATE_TRIGGER = 'config:updateTrigger';

/** Remove notification trigger */
export const CONFIG_REMOVE_TRIGGER = 'config:removeTrigger';

/** Get all triggers */
export const CONFIG_GET_TRIGGERS = 'config:getTriggers';

/** Test a trigger */
export const CONFIG_TEST_TRIGGER = 'config:testTrigger';

/** Select folders dialog */
export const CONFIG_SELECT_FOLDERS = 'config:selectFolders';

/** Select local Claude root folder */
export const CONFIG_SELECT_CLAUDE_ROOT_FOLDER = 'config:selectClaudeRootFolder';

/** Get effective/default Claude root folder info */
export const CONFIG_GET_CLAUDE_ROOT_INFO = 'config:getClaudeRootInfo';

/** Find WSL Claude root candidates (Windows only) */
export const CONFIG_FIND_WSL_CLAUDE_ROOTS = 'config:findWslClaudeRoots';

/** Open config file in external editor */
export const CONFIG_OPEN_IN_EDITOR = 'config:openInEditor';

/** Pin a session */
export const CONFIG_PIN_SESSION = 'config:pinSession';

/** Unpin a session */
export const CONFIG_UNPIN_SESSION = 'config:unpinSession';

/** Hide a session */
export const CONFIG_HIDE_SESSION = 'config:hideSession';

/** Unhide a session */
export const CONFIG_UNHIDE_SESSION = 'config:unhideSession';

/** Bulk hide sessions */
export const CONFIG_HIDE_SESSIONS = 'config:hideSessions';

/** Bulk unhide sessions */
export const CONFIG_UNHIDE_SESSIONS = 'config:unhideSessions';

// =============================================================================
// SSH API Channels
// =============================================================================

/** Connect to SSH host */
export const SSH_CONNECT = 'ssh:connect';

/** Disconnect SSH and switch to local */
export const SSH_DISCONNECT = 'ssh:disconnect';

/** Get current SSH connection state */
export const SSH_GET_STATE = 'ssh:getState';

/** Test SSH connection without switching */
export const SSH_TEST = 'ssh:test';

/** Get SSH config hosts from ~/.ssh/config */
export const SSH_GET_CONFIG_HOSTS = 'ssh:getConfigHosts';

/** Resolve a single SSH config host alias */
export const SSH_RESOLVE_HOST = 'ssh:resolveHost';

/** Save last SSH connection config */
export const SSH_SAVE_LAST_CONNECTION = 'ssh:saveLastConnection';

/** Get last saved SSH connection config */
export const SSH_GET_LAST_CONNECTION = 'ssh:getLastConnection';

/** SSH status event channel (main -> renderer) */
export const SSH_STATUS = 'ssh:status';

// =============================================================================
// Updater API Channels
// =============================================================================

/** Check for updates */
export const UPDATER_CHECK = 'updater:check';

/** Download available update */
export const UPDATER_DOWNLOAD = 'updater:download';

/** Quit and install downloaded update */
export const UPDATER_INSTALL = 'updater:install';

/** Status event channel (main -> renderer) */
export const UPDATER_STATUS = 'updater:status';

// =============================================================================
// Context API Channels
// =============================================================================

/** List all available contexts (local + SSH) */
export const CONTEXT_LIST = 'context:list';

/** Get active context ID */
export const CONTEXT_GET_ACTIVE = 'context:getActive';

/** Switch to a different context */
export const CONTEXT_SWITCH = 'context:switch';

/** Context changed event channel (main -> renderer) */
export const CONTEXT_CHANGED = 'context:changed';

// =============================================================================
// HTTP Server API Channels
// =============================================================================

/** Start HTTP sidecar server */
export const HTTP_SERVER_START = 'httpServer:start';

/** Stop HTTP sidecar server */
export const HTTP_SERVER_STOP = 'httpServer:stop';

/** Get HTTP server status */
export const HTTP_SERVER_GET_STATUS = 'httpServer:getStatus';

// =============================================================================
// Window Controls API (Windows / Linux — native title bar is hidden)
// =============================================================================

/** Minimize window */
export const WINDOW_MINIMIZE = 'window:minimize';

/** Maximize or restore window */
export const WINDOW_MAXIMIZE = 'window:maximize';

/** Close window */
export const WINDOW_CLOSE = 'window:close';

/** Whether the window is currently maximized */
export const WINDOW_IS_MAXIMIZED = 'window:isMaximized';

/** Whether the window is in fullscreen (macOS native fullscreen) */
export const WINDOW_IS_FULLSCREEN = 'window:isFullScreen';

/** Event: (isFullScreen: boolean) when window enters or leaves fullscreen */
export const WINDOW_FULLSCREEN_CHANGED = 'window:fullscreen-changed';

/** Relaunch the application */
export const APP_RELAUNCH = 'app:relaunch';

// =============================================================================
// Team API Channels
// =============================================================================

/** List all teams */
export const TEAM_LIST = 'team:list';

/** Get detailed team data */
export const TEAM_GET_DATA = 'team:getData';

/** Update team kanban state */
export const TEAM_UPDATE_KANBAN = 'team:updateKanban';

/** Update kanban column task order (drag-and-drop within column) */
export const TEAM_UPDATE_KANBAN_COLUMN_ORDER = 'team:updateKanbanColumnOrder';

/** Send inbox message to team member */
export const TEAM_SEND_MESSAGE = 'team:sendMessage';

/** Request review for task */
export const TEAM_REQUEST_REVIEW = 'team:requestReview';

/** Team change events (main -> renderer) */
export const TEAM_CHANGE = 'team:change';

/** Create new team by provisioning through CLI */
export const TEAM_CREATE = 'team:create';

/** Launch existing offline team */
export const TEAM_LAUNCH = 'team:launch';

/** Warm up provisioning runtime before create */
export const TEAM_PREPARE_PROVISIONING = 'team:prepareProvisioning';

/** Get provisioning status by runId */
export const TEAM_PROVISIONING_STATUS = 'team:provisioningStatus';

/** Cancel running provisioning by runId */
export const TEAM_CANCEL_PROVISIONING = 'team:cancelProvisioning';

/** Team provisioning progress events (main -> renderer) */
export const TEAM_PROVISIONING_PROGRESS = 'team:provisioningProgress';

/** Send message to team's live CLI process via stream-json stdin */
export const TEAM_PROCESS_SEND = 'team:processSend';

/** Check if team has a live CLI process */
export const TEAM_PROCESS_ALIVE = 'team:processAlive';

/** Create a task in team's task directory */
export const TEAM_CREATE_TASK = 'team:createTask';

/** Update task status directly (pending/in_progress/completed) */
export const TEAM_UPDATE_TASK_STATUS = 'team:updateTaskStatus';

/** Update task owner (reassign) */
export const TEAM_UPDATE_TASK_OWNER = 'team:updateTaskOwner';

/** Delete a team and its associated task directory */
export const TEAM_DELETE_TEAM = 'team:deleteTeam';

/** Get list of teams with live CLI processes */
export const TEAM_ALIVE_LIST = 'team:aliveList';
export const TEAM_STOP = 'team:stop';

/** Create team config without provisioning CLI */
export const TEAM_CREATE_CONFIG = 'team:createConfig';

/** Get member subagent logs */
export const TEAM_GET_MEMBER_LOGS = 'team:getMemberLogs';

/** Get session logs that reference a task */
export const TEAM_GET_LOGS_FOR_TASK = 'team:getLogsForTask';

/** Update team config (name, description) */
export const TEAM_UPDATE_CONFIG = 'team:updateConfig';

/** Get aggregated member stats */
export const TEAM_GET_MEMBER_STATS = 'team:getMemberStats';

/** Start a pending task (transition to in_progress + notify agent) */
export const TEAM_START_TASK = 'team:startTask';

/** Get all tasks across all teams */
export const TEAM_GET_ALL_TASKS = 'team:getAllTasks';

/** Add a comment to a task */
export const TEAM_ADD_TASK_COMMENT = 'team:addTaskComment';

/** Get current git branch for a project path (live read from .git/HEAD) */
export const TEAM_GET_PROJECT_BRANCH = 'team:getProjectBranch';

/** Add a new member to an existing team */
export const TEAM_ADD_MEMBER = 'team:addMember';

/** Soft-delete a team member */
export const TEAM_REMOVE_MEMBER = 'team:removeMember';

/** Update a team member's role */
export const TEAM_UPDATE_MEMBER_ROLE = 'team:updateMemberRole';

/** Get attachment data for a message */
export const TEAM_GET_ATTACHMENTS = 'team:getAttachments';
