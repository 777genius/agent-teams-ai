import { useStore } from '@renderer/store';

export function useOpenTokenUsageTask(): (teamName: string, taskId: string) => void {
  return useStore((state) => state.openGlobalTaskDetail);
}
