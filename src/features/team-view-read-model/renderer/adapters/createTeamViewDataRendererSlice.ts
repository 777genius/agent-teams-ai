import { createTeamViewDataRendererSlice as createSlice } from '../slices/createTeamViewDataRendererSlice';

import { createTeamViewDataTransport } from './createTeamViewDataTransport';

import type {
  TeamViewDataRendererSlice,
  TeamViewDataRendererSliceDependencies as CanonicalDependencies,
  TeamViewDataTransportPort,
} from '../ports/TeamViewDataRendererPorts';

export type TeamViewDataRendererSliceDependencies<TScope, TNotification> = Omit<
  CanonicalDependencies<TScope, TNotification>,
  'transport'
> & {
  transport?: TeamViewDataTransportPort;
};

export function createTeamViewDataRendererSlice<TScope, TNotification>(
  dependencies: TeamViewDataRendererSliceDependencies<TScope, TNotification>
): TeamViewDataRendererSlice {
  return createSlice({
    ...dependencies,
    transport: dependencies.transport ?? createTeamViewDataTransport(),
  });
}
