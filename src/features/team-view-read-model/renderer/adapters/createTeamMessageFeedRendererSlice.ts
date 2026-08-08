import { createTeamMessageFeedRendererSlice as createSlice } from '../slices/createTeamMessageFeedRendererSlice';

import { createTeamMessageFeedTransport } from './createTeamMessageFeedTransport';

import type {
  TeamMessageFeedRendererSlice,
  TeamMessageFeedRendererSliceDependencies as CanonicalDependencies,
  TeamMessageFeedTransportPort,
} from '../ports/TeamMessageFeedRendererPorts';

export type TeamMessageFeedRendererSliceDependencies<TScope> = Omit<
  CanonicalDependencies<TScope>,
  'transport'
> & {
  transport?: TeamMessageFeedTransportPort;
};

export type { TeamMessageFeedRendererSlice };

export function createTeamMessageFeedRendererSlice<TScope>(
  dependencies: TeamMessageFeedRendererSliceDependencies<TScope>
): TeamMessageFeedRendererSlice {
  return createSlice({
    ...dependencies,
    transport: dependencies.transport ?? createTeamMessageFeedTransport(),
  });
}
