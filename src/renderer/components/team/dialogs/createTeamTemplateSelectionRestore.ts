/**
 * Restore-side parsing for the persisted `createTeam:templateSelection` draft.
 *
 * The dialog owns the draft; this helper is the single place that interprets
 * its stored JSON so restoration stays tolerant: malformed JSON, a missing
 * field, or a source outside the known union all degrade to "nothing valid
 * saved" without ever writing back to the draft. Restoration only feeds the
 * picker's initial selection — it never re-applies template content.
 */

export type CreateTeamTemplateSource = 'none' | 'builtin' | 'custom';

const TEMPLATE_SOURCES: readonly string[] = ['none', 'builtin', 'custom'];

export interface StoredTemplateSelection {
  /** Stored template source, or null when absent or invalid. */
  source: CreateTeamTemplateSource | null;
  /** Picker selection value (`builtin:<id>` / `custom:<id>` / `none`), empty when absent. */
  value: string;
}

export function readStoredTemplateSelection(raw: string | undefined): StoredTemplateSelection {
  if (!raw) return { source: null, value: '' };
  try {
    const parsed = JSON.parse(raw) as { source?: unknown; value?: unknown };
    const source =
      typeof parsed.source === 'string' && TEMPLATE_SOURCES.includes(parsed.source)
        ? (parsed.source as CreateTeamTemplateSource)
        : null;
    return { source, value: typeof parsed.value === 'string' ? parsed.value : '' };
  } catch {
    return { source: null, value: '' };
  }
}
