import { useStore } from '@renderer/store';

export function useOpenTokenUsageTeam(): (teamName: string) => void {
  return useStore((state) => state.openTeamTab);
}
