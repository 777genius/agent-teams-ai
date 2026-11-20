import type { TeamConfigurationUpdate } from '@main/services/team/TeamConfigurationMutations';
import type { TeamUpdateConfigRequest } from '@shared/types';

/** Same bound as the external (HTTP/MCP) lead instructions. */
export const MAX_LEAD_PROMPT_LENGTH = 200_000;

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
  if (
    prompt !== undefined &&
    (typeof prompt !== 'string' || prompt.length > MAX_LEAD_PROMPT_LENGTH)
  ) {
    return { ok: false, error: 'prompt must be a bounded string' };
  }
  return { ok: true, value: { name, description, color, prompt } };
}
