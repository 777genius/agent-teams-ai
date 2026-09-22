import {
  getStoredCreateTeamModel,
  setStoredCreateTeamModel,
  setStoredCreateTeamProvider,
} from '@renderer/services/createTeamPreferences';

export function getOpenCodeModelForNewTeams(): string | null {
  const modelId = getStoredCreateTeamModel('opencode').trim();
  return modelId.length > 0 ? modelId : null;
}

export function saveOpenCodeModelForNewTeams(modelId: string): void {
  setStoredCreateTeamProvider('opencode');
  setStoredCreateTeamModel('opencode', modelId);
}
