export interface MentionSuggestion {
  /** Unique key (name or draft.id) */
  id: string;
  /** Human-readable primary label (for tasks: short display id without `#`) */
  name: string;
  /** Role displayed in suggestion list */
  subtitle?: string;
  /** Optional description for command and rich suggestion tooltips */
  description?: string;
  /** Color name from TeamColorSet palette */
  color?: string;
  /** Suggestion type — 'member' (default), 'team', 'file', 'folder', 'task', or 'command' */
  type?: 'member' | 'team' | 'file' | 'folder' | 'task' | 'command';
  /** Whether the team is currently online (team suggestions only) */
  isOnline?: boolean;
  /** Absolute file/folder path (file/folder suggestions only) */
  filePath?: string;
  /** Relative display path (file/folder suggestions only) */
  relativePath?: string;
  /** Optional exact text inserted after the trigger (defaults to `name`) */
  insertText?: string;
  /** Optional extra searchable text (subject, team name, path, etc.) */
  searchText?: string;
  /** Optional slash command string including leading slash (command suggestions only) */
  command?: `/${string}`;
  /** Canonical task id (task suggestions only) */
  taskId?: string;
  /** Owning team name (task suggestions only) */
  teamName?: string;
  /** Owning team display name (task suggestions only) */
  teamDisplayName?: string;
  /** Whether the task belongs to the currently active team */
  isCurrentTeamTask?: boolean;
  /** Owning task owner name (task suggestions only) */
  ownerName?: string;
  /** Owning task owner color (task suggestions only) */
  ownerColor?: string;
}
