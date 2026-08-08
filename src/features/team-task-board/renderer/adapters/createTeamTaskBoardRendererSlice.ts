import { createTeamTaskBoardRendererSlice as createSlice } from '../slices/createTeamTaskBoardRendererSlice';

import { createTeamTaskBoardTransport } from './createTeamTaskBoardTransport';

import type {
  TeamTaskBoardRendererSlice,
  TeamTaskBoardRendererSliceDependencies as CanonicalDependencies,
  TeamTaskBoardRendererStoreContext,
  TeamTaskBoardTransport,
} from '../ports/TeamTaskBoardRendererPorts';

export type TeamTaskBoardRendererSliceDependencies = Omit<CanonicalDependencies, 'transport'> & {
  transport?: TeamTaskBoardTransport;
};

export type { TeamTaskBoardRendererSlice, TeamTaskBoardRendererStoreContext };

export function createTeamTaskBoardRendererSlice(
  dependencies: TeamTaskBoardRendererSliceDependencies
): TeamTaskBoardRendererSlice {
  return createSlice({
    ...dependencies,
    transport: dependencies.transport ?? createTeamTaskBoardTransport(),
  });
}
