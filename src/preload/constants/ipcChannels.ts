/**
 * IPC Channel Constants
 *
 * Centralized IPC channel names to avoid string duplication in preload bridge.
 */

// =============================================================================
// Diagnostics / Logging Channels
// =============================================================================

/** Renderer -> main log forwarding (filtered in preload) */
export const RENDERER_LOG = 'renderer:log';

/** Renderer -> main lifecycle signal (preload executed) */
export const RENDERER_BOOT = 'renderer:boot';

/** Renderer -> main heartbeat (detect renderer stalls) */
export const RENDERER_HEARTBEAT = 'renderer:heartbeat';

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

/** Add a custom project path (Select Folder persistence) */
export const CONFIG_ADD_CUSTOM_PROJECT_PATH = 'config:addCustomProjectPath';

/** Remove a custom project path */
export const CONFIG_REMOVE_CUSTOM_PROJECT_PATH = 'config:removeCustomProjectPath';

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

/** Get lightweight task change presence map for the currently viewed team */
export const TEAM_GET_TASK_CHANGE_PRESENCE = 'team:getTaskChangePresence';

/** Enable or disable task change presence tracking for a visible team tab */
export const TEAM_SET_CHANGE_PRESENCE_TRACKING = 'team:setChangePresenceTracking';

/** Enable or disable live teammate tool activity tracking for a visible team tab */
export const TEAM_SET_TOOL_ACTIVITY_TRACKING = 'team:setToolActivityTracking';

/** Get buffered Claude CLI logs (paged, newest-first) */
export const TEAM_GET_CLAUDE_LOGS = 'team:getClaudeLogs';

/** Update team kanban state */
export const TEAM_UPDATE_KANBAN = 'team:updateKanban';

/** Update kanban column task order (drag-and-drop within column) */
export const TEAM_UPDATE_KANBAN_COLUMN_ORDER = 'team:updateKanbanColumnOrder';

/** Send inbox message to team member */
export const TEAM_SEND_MESSAGE = 'team:sendMessage';

/** Paginated messages for timeline/messages panel */
export const TEAM_GET_MESSAGES_PAGE = 'team:getMessagesPage';

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

/** Update task fields (subject, description) */
export const TEAM_UPDATE_TASK_FIELDS = 'team:updateTaskFields';

/** Soft-delete a team (sets deletedAt in config) */
export const TEAM_DELETE_TEAM = 'team:deleteTeam';

/** Restore a soft-deleted team (removes deletedAt from config) */
export const TEAM_RESTORE = 'team:restoreTeam';

/** Permanently delete a team and its associated task directory */
export const TEAM_PERMANENTLY_DELETE = 'team:permanentlyDeleteTeam';

/** Restore a soft-deleted task (removes deletedAt, sets status back to pending) */
export const TEAM_RESTORE_TASK = 'team:restoreTask';

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

/** Start a pending task from UI — always notifies owner (including lead in solo teams) */
export const TEAM_START_TASK_BY_USER = 'team:startTaskByUser';

/** Get all tasks across all teams */
export const TEAM_GET_ALL_TASKS = 'team:getAllTasks';

/** Add a comment to a task */
export const TEAM_ADD_TASK_COMMENT = 'team:addTaskComment';

/** Get current git branch for a project path (live read from .git/HEAD) */
export const TEAM_GET_PROJECT_BRANCH = 'team:getProjectBranch';

/** Enable or disable background tracking for a project path's git branch */
export const TEAM_SET_PROJECT_BRANCH_TRACKING = 'team:setProjectBranchTracking';

/** Push event: tracked project branch changed (main → renderer) */
export const TEAM_PROJECT_BRANCH_CHANGE = 'team:projectBranchChange';

/** Add a new member to an existing team */
export const TEAM_ADD_MEMBER = 'team:addMember';

/** Replace all team members (bulk edit) */
export const TEAM_REPLACE_MEMBERS = 'team:replaceMembers';

/** Soft-delete a team member */
export const TEAM_REMOVE_MEMBER = 'team:removeMember';

/** Update a team member's role */
export const TEAM_UPDATE_MEMBER_ROLE = 'team:updateMemberRole';

/** Get attachment data for a message */
export const TEAM_GET_ATTACHMENTS = 'team:getAttachments';

/** Kill a registered CLI process by PID */
export const TEAM_KILL_PROCESS = 'team:killProcess';

/** Get lead process activity state (active/idle/offline) */
export const TEAM_LEAD_ACTIVITY = 'team:leadActivity';

/** Get lead process context window usage */
export const TEAM_LEAD_CONTEXT = 'team:leadContext';

/** Get per-member spawn statuses for a team */
export const TEAM_MEMBER_SPAWN_STATUSES = 'team:memberSpawnStatuses';

/** Soft-delete a task (set status to 'deleted' with deletedAt timestamp) */
export const TEAM_SOFT_DELETE_TASK = 'team:softDeleteTask';

/** Get all soft-deleted tasks for a team */
export const TEAM_GET_DELETED_TASKS = 'team:getDeletedTasks';

/** Set needsClarification flag on a task */
export const TEAM_SET_TASK_CLARIFICATION = 'team:setTaskClarification';

/** Show native OS notification for a team message */
export const TEAM_SHOW_MESSAGE_NOTIFICATION = 'team:showMessageNotification';

/** Add a relationship (blockedBy/blocks/related) between two tasks */
export const TEAM_ADD_TASK_RELATIONSHIP = 'team:addTaskRelationship';

/** Remove a relationship (blockedBy/blocks/related) between two tasks */
export const TEAM_REMOVE_TASK_RELATIONSHIP = 'team:removeTaskRelationship';

/** Save an image attachment to a task */
export const TEAM_SAVE_TASK_ATTACHMENT = 'team:saveTaskAttachment';

/** Get base64 data for a task attachment */
export const TEAM_GET_TASK_ATTACHMENT = 'team:getTaskAttachment';

/** Delete an attachment from a task */
export const TEAM_DELETE_TASK_ATTACHMENT = 'team:deleteTaskAttachment';

/** Push event: tool approval request or dismissal (main → renderer) */
export const TEAM_TOOL_APPROVAL_EVENT = 'team:toolApprovalEvent';

/** Invoke: respond to a tool approval request (renderer → main) */
export const TEAM_TOOL_APPROVAL_RESPOND = 'team:toolApprovalRespond';

/** Validate custom CLI args against `claude --help` output */
export const TEAM_VALIDATE_CLI_ARGS = 'team:validateCliArgs';

/** Invoke: update tool approval settings (renderer → main) */
export const TEAM_TOOL_APPROVAL_SETTINGS = 'team:toolApprovalSettings';

/** Invoke: read file content for tool approval diff preview (renderer → main) */
export const TEAM_TOOL_APPROVAL_READ_FILE = 'team:toolApprovalReadFile';

export const TEAM_GET_SAVED_REQUEST = 'team:getSavedRequest';
export const TEAM_DELETE_DRAFT = 'team:deleteDraft';

// =============================================================================
// Cross-Team Communication Channels
// =============================================================================

/** Send cross-team message */
export const CROSS_TEAM_SEND = 'crossTeam:send';

/** List available cross-team targets */
export const CROSS_TEAM_LIST_TARGETS = 'crossTeam:listTargets';

/** Get cross-team outbox for a team */
export const CROSS_TEAM_GET_OUTBOX = 'crossTeam:getOutbox';

// =============================================================================
// CLI Installer API Channels
// =============================================================================

/** Get CLI installation status */
export const CLI_INSTALLER_GET_STATUS = 'cliInstaller:getStatus';

/** Start CLI install/update */
export const CLI_INSTALLER_INSTALL = 'cliInstaller:install';

/** CLI installer progress events (main -> renderer) */
export const CLI_INSTALLER_PROGRESS = 'cliInstaller:progress';

/** Invalidate cached CLI status (forces fresh check on next getStatus) */
export const CLI_INSTALLER_INVALIDATE_STATUS = 'cliInstaller:invalidateStatus';

// =============================================================================
// Terminal API Channels
// =============================================================================

/** Spawn a new PTY terminal process */
export const TERMINAL_SPAWN = 'terminal:spawn';

/** Write data to PTY stdin (fire-and-forget) */
export const TERMINAL_WRITE = 'terminal:write';

/** Resize PTY terminal (fire-and-forget) */
export const TERMINAL_RESIZE = 'terminal:resize';

/** Kill PTY process (fire-and-forget) */
export const TERMINAL_KILL = 'terminal:kill';

/** PTY data output (main -> renderer) */
export const TERMINAL_DATA = 'terminal:data';

/** PTY process exit (main -> renderer) */
export const TERMINAL_EXIT = 'terminal:exit';

// =============================================================================
// Review API Channels
// =============================================================================

/** Получить все изменения агента */
export const REVIEW_GET_AGENT_CHANGES = 'review:getAgentChanges';

/** Получить изменения задачи */
export const REVIEW_GET_TASK_CHANGES = 'review:getTaskChanges';

/** Инвалидировать persisted/in-memory summary cache для задач */
export const REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES = 'review:invalidateTaskChangeSummaries';

/** Получить краткую статистику изменений */
export const REVIEW_GET_CHANGE_STATS = 'review:getChangeStats';

// Phase 2 — Review actions

/** Проверить конфликт файла (изменён ли на диске) */
export const REVIEW_CHECK_CONFLICT = 'review:checkConflict';

/** Откатить выбранные hunks */
export const REVIEW_REJECT_HUNKS = 'review:rejectHunks';

/** Откатить весь файл к оригиналу */
export const REVIEW_REJECT_FILE = 'review:rejectFile';

/** Preview результата reject (без записи на диск) */
export const REVIEW_PREVIEW_REJECT = 'review:previewReject';

/** Применить batch решений review */
export const REVIEW_APPLY_DECISIONS = 'review:applyDecisions';

/** Получить полное содержимое файла для diff view */
export const REVIEW_GET_FILE_CONTENT = 'review:getFileContent';

/** Start/update focused file watcher for review surface */
export const REVIEW_WATCH_FILES = 'review:watchFiles';

/** Stop focused file watcher for review surface */
export const REVIEW_UNWATCH_FILES = 'review:unwatchFiles';

/** File change event for review watcher (main -> renderer) */
export const REVIEW_FILE_CHANGE = 'review:fileChange';

// Phase 4 — Git fallback

/** Save edited file content to disk */
export const REVIEW_SAVE_EDITED_FILE = 'review:saveEditedFile';

/** Get git file change log */
export const REVIEW_GET_GIT_FILE_LOG = 'review:getGitFileLog';

/** Load persisted review decisions from disk */
export const REVIEW_LOAD_DECISIONS = 'review:loadDecisions';

/** Save review decisions to disk */
export const REVIEW_SAVE_DECISIONS = 'review:saveDecisions';

/** Clear review decisions from disk */
export const REVIEW_CLEAR_DECISIONS = 'review:clearDecisions';

// =============================================================================
// Editor Channels
// =============================================================================

/** Initialize editor, set activeProjectRoot in module-level state */
export const EDITOR_OPEN = 'editor:open';

/** Cleanup: reset activeProjectRoot, stop watcher */
export const EDITOR_CLOSE = 'editor:close';

/** Recursive directory reading (depth=1, lazy) */
export const EDITOR_READ_DIR = 'editor:readDir';

/** Read file content with binary detection */
export const EDITOR_READ_FILE = 'editor:readFile';

/** Write file content (atomic write) */
export const EDITOR_WRITE_FILE = 'editor:writeFile';

/** Create a new file */
export const EDITOR_CREATE_FILE = 'editor:createFile';

/** Create a new directory */
export const EDITOR_CREATE_DIR = 'editor:createDir';

/** Delete file or directory (move to Trash) */
export const EDITOR_DELETE_FILE = 'editor:deleteFile';

/** Move file or directory to a new location */
export const EDITOR_MOVE_FILE = 'editor:moveFile';

/** Rename file or directory in place */
export const EDITOR_RENAME_FILE = 'editor:renameFile';

/** Search in files (literal string search) */
export const EDITOR_SEARCH_IN_FILES = 'editor:searchInFiles';

/** List all project files (for Quick Open) */
export const EDITOR_LIST_FILES = 'editor:listFiles';

/** Get git status for current project */
export const EDITOR_GIT_STATUS = 'editor:gitStatus';

/** Enable/disable file watcher for current project */
export const EDITOR_WATCH_DIR = 'editor:watchDir';

/** Update list of watched file paths (open tabs) */
export const EDITOR_SET_WATCHED_FILES = 'editor:setWatchedFiles';

/** Update list of watched directories (shallow: depth=0) */
export const EDITOR_SET_WATCHED_DIRS = 'editor:setWatchedDirs';

/** Read binary file as base64 for inline preview */
export const EDITOR_READ_BINARY_PREVIEW = 'editor:readBinaryPreview';

/** File change event from watcher (main -> renderer) */
export const EDITOR_CHANGE = 'editor:change';

/** List project files by path (for @file mentions, independent of editor state) */
export const PROJECT_LIST_FILES = 'project:listFiles';

// =============================================================================
// Schedule Channels
// =============================================================================

/** List all schedules */
export const SCHEDULE_LIST = 'schedule:list';

/** Get a schedule by ID */
export const SCHEDULE_GET = 'schedule:get';

/** Create a new schedule */
export const SCHEDULE_CREATE = 'schedule:create';

/** Update an existing schedule */
export const SCHEDULE_UPDATE = 'schedule:update';

/** Delete a schedule */
export const SCHEDULE_DELETE = 'schedule:delete';

/** Pause a schedule */
export const SCHEDULE_PAUSE = 'schedule:pause';

/** Resume a paused schedule */
export const SCHEDULE_RESUME = 'schedule:resume';

/** Trigger immediate run of a schedule */
export const SCHEDULE_TRIGGER_NOW = 'schedule:triggerNow';

/** Get run history for a schedule */
export const SCHEDULE_GET_RUNS = 'schedule:getRuns';

/** Get full stdout/stderr logs for a specific run */
export const SCHEDULE_GET_RUN_LOGS = 'schedule:getRunLogs';

/** Schedule change events (main -> renderer) */
export const SCHEDULE_CHANGE = 'schedule:change';

// Extensions / Plugin Catalog Channels
// =============================================================================

/** Get all enriched plugins (catalog + installed state + counts) */
export const PLUGIN_GET_ALL = 'plugin:getAll';

/** Get README content for a plugin by pluginId */
export const PLUGIN_GET_README = 'plugin:getReadme';

// =============================================================================
// Extensions / MCP Registry Channels
// =============================================================================

/** Search MCP servers across registries */
export const MCP_REGISTRY_SEARCH = 'mcpRegistry:search';

/** Browse MCP catalog with pagination */
export const MCP_REGISTRY_BROWSE = 'mcpRegistry:browse';

/** Get a single MCP server by registry ID */
export const MCP_REGISTRY_GET_BY_ID = 'mcpRegistry:getById';

/** Get installed MCP servers */
export const MCP_REGISTRY_GET_INSTALLED = 'mcpRegistry:getInstalled';

/** Run Claude CLI MCP health diagnostics */
export const MCP_REGISTRY_DIAGNOSE = 'mcpRegistry:diagnose';

/** Install a plugin */
export const PLUGIN_INSTALL = 'plugin:install';

/** Uninstall a plugin */
export const PLUGIN_UNINSTALL = 'plugin:uninstall';

/** Install an MCP server */
export const MCP_REGISTRY_INSTALL = 'mcpRegistry:install';

/** Uninstall an MCP server */
export const MCP_REGISTRY_UNINSTALL = 'mcpRegistry:uninstall';

/** Install a custom MCP server (bypasses registry) */
export const MCP_REGISTRY_INSTALL_CUSTOM = 'mcpRegistry:installCustom';

/** Fetch GitHub stars for MCP server repositories */
export const MCP_GITHUB_STARS = 'mcpRegistry:githubStars';

// =============================================================================
// Extensions / Skills Channels
// =============================================================================

/** List discovered local skills */
export const SKILLS_LIST = 'skills:list';

/** Get full detail for a discovered skill */
export const SKILLS_GET_DETAIL = 'skills:getDetail';

/** Preview create/update changes for a skill */
export const SKILLS_PREVIEW_UPSERT = 'skills:previewUpsert';

/** Apply create/update changes for a skill */
export const SKILLS_APPLY_UPSERT = 'skills:applyUpsert';

/** Preview import changes for a skill folder */
export const SKILLS_PREVIEW_IMPORT = 'skills:previewImport';

/** Apply import for a skill folder */
export const SKILLS_APPLY_IMPORT = 'skills:applyImport';

/** Delete an existing skill */
export const SKILLS_DELETE = 'skills:delete';

/** Start focused watcher for active skill roots */
export const SKILLS_START_WATCHING = 'skills:startWatching';

/** Stop focused watcher for active skill roots */
export const SKILLS_STOP_WATCHING = 'skills:stopWatching';

/** Renderer event for focused skill root changes */
export const SKILLS_CHANGED = 'skills:changed';

// =============================================================================
// API Keys Management Channels
// =============================================================================

/** List all saved API keys (masked values) */
export const API_KEYS_LIST = 'apiKeys:list';

/** Save (create or update) an API key */
export const API_KEYS_SAVE = 'apiKeys:save';

/** Delete an API key by ID */
export const API_KEYS_DELETE = 'apiKeys:delete';

/** Lookup decrypted values by env var names (for auto-fill) */
export const API_KEYS_LOOKUP = 'apiKeys:lookup';

/** Get storage encryption status (for UI display) */
export const API_KEYS_STORAGE_STATUS = 'apiKeys:storageStatus';
