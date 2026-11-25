/** Maximum character length for messages and comments in team communication. */
export const MAX_TEXT_LENGTH = 50_000;

/**
 * Maximum character length of a free-text field of a team definition: the saved
 * lead instructions, the description, member roles and workflows. One bound for
 * the app dialog, IPC and the external (HTTP/MCP) writers.
 */
export const MAX_TEAM_DEFINITION_TEXT_LENGTH = 200_000;
