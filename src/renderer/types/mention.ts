export interface MentionSuggestion {
  /** Unique key (name or draft.id) */
  id: string;
  /** Name to insert: @name */
  name: string;
  /** Role displayed in suggestion list */
  subtitle?: string;
  /** Color name from TeamColorSet palette */
  color?: string;
  /** Suggestion type — 'member' (default), 'team', 'file', or 'folder' */
  type?: 'member' | 'team' | 'file' | 'folder';
  /** Whether the team is currently online (team suggestions only) */
  isOnline?: boolean;
  /** Absolute file/folder path (file/folder suggestions only) */
  filePath?: string;
  /** Relative display path (file/folder suggestions only) */
  relativePath?: string;
}
