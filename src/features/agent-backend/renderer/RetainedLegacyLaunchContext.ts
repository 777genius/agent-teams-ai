import { createContext, useContext } from 'react';

import type { RetainedLegacyLaunchClient } from './retainedLegacyLaunch';

type ProjectRebind = (projectPath: string, apply: (projectPath: string) => void) => Promise<void>;
export const RetainedLegacyLaunchContext = createContext<RetainedLegacyLaunchClient | null>(null);
export const RetainedLegacyProjectContext = createContext<ProjectRebind | null>(null);
export function useRetainedLegacyLaunch(): RetainedLegacyLaunchClient | null {
  return useContext(RetainedLegacyLaunchContext);
}
export function useRetainedLegacyProjectRebind(): ProjectRebind | null {
  return useContext(RetainedLegacyProjectContext);
}
