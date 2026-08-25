import {
  AdoptTeamRoster,
  type AdoptTeamRosterDependencies,
  type AdoptTeamRosterRequest,
  type AdoptTeamRosterResult,
  type TeamRosterRepository,
} from '../../core/application';

export interface TeamRosterAdoptionFeature {
  adoptTeamRoster(request: AdoptTeamRosterRequest): Promise<AdoptTeamRosterResult>;
  rosterRepository: TeamRosterRepository;
}

export type TeamRosterAdoptionFeatureDependencies = AdoptTeamRosterDependencies;

export function createTeamRosterAdoptionFeature(
  dependencies: TeamRosterAdoptionFeatureDependencies
): TeamRosterAdoptionFeature {
  const useCase = new AdoptTeamRoster(dependencies);
  return Object.freeze({
    adoptTeamRoster: (request: AdoptTeamRosterRequest) => useCase.execute(request),
    rosterRepository: dependencies.repository,
  });
}
