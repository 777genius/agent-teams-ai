import { MAX_TEAM_DEFINITION_TEXT_LENGTH } from '@shared/constants/teamLimits';

import type { TeamConfigurationUpdate } from '@main/services/team/TeamConfigurationMutations';
import type { TeamUpdateConfigRequest } from '@shared/types';

export const LEAD_PROMPT_TOO_LONG_MESSAGE = `Lead instructions are too long (at most ${MAX_TEAM_DEFINITION_TEXT_LENGTH} characters)`;

export type ParsedUpdateConfig =
  | { ok: true; value: TeamConfigurationUpdate }
  | { ok: false; error: string };

/** Validates the renderer payload of the update-config call; unknown fields are ignored. */
export function parseUpdateConfigRequest(updates: unknown): ParsedUpdateConfig {
  if (!updates || typeof updates !== 'object') {
    return { ok: false, error: 'Invalid updates object' };
  }
  const { name, description, color, prompt } = updates as TeamUpdateConfigRequest;
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, error: 'name must be a string' };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { ok: false, error: 'description must be a string' };
  }
  if (color !== undefined && typeof color !== 'string') {
    return { ok: false, error: 'color must be a string' };
  }
  if (prompt !== undefined && typeof prompt !== 'string') {
    return { ok: false, error: 'prompt must be a string' };
  }
  if (typeof prompt === 'string' && prompt.length > MAX_TEAM_DEFINITION_TEXT_LENGTH) {
    return { ok: false, error: LEAD_PROMPT_TOO_LONG_MESSAGE };
  }
  return { ok: true, value: { name, description, color, prompt } };
}

/** Validate before a live definition edit creates its recovery marker. */
export async function preflightConfigUpdate(_teamName: string, updates: unknown): Promise<void> {
  const parsed = parseUpdateConfigRequest(updates);
  if (!parsed.ok) throw new Error(parsed.error);
}
