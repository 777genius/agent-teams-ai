import type { TeamCreateDraft, TeamCreateRequest } from '../types/team';

/** The same product choices qualify preparation and submission; transport evidence is excluded. */
export function captureCreatedTeamDraft(request: TeamCreateRequest): TeamCreateDraft {
  const {
    command: _command,
    savedSettingsFingerprint: _saved,
    createdTeamReadiness: _readiness,
    ...draft
  } = request;
  // Wire normalization excludes optional undefined fields, preserving array order.
  return JSON.parse(JSON.stringify(draft)) as TeamCreateDraft;
}

export function createdTeamSelectionSignature(request: TeamCreateRequest): string {
  return JSON.stringify(canonical(captureCreatedTeamDraft(request)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  return value;
}
