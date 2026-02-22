export interface MentionSuggestion {
  /** Unique key (name or draft.id) */
  id: string;
  /** Name to insert: @name */
  name: string;
  /** Role displayed in suggestion list */
  subtitle?: string;
  /** Color name from TeamColorSet palette */
  color?: string;
}
