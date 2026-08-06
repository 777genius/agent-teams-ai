import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const LEGACY_COORDINATOR_PATH = 'src/main/services/team/TeamMessagePersistenceCoordinator.ts';
const SERVICE_PATH = 'src/main/services/team/TeamDataService.ts';
const SERVICE_COMPOSITION_PATH = 'src/main/services/team/TeamDataServiceFeatureComposition.ts';
const LEGACY_COMPOSITION_PATH =
  'src/main/services/team/TeamDataServiceLegacyCompatibilityComposition.ts';
const COORDINATOR_PATH =
  'src/features/team-message-delivery/core/application/services/TeamMessagePersistenceCoordinator.ts';
const PORTS_PATH =
  'src/features/team-message-delivery/core/application/ports/TeamMessagePersistencePorts.ts';
const FEATURE_COMPOSITION_PATH =
  'src/features/team-message-delivery/main/composition/createTeamMessageDeliveryFeature.ts';
const FEATURE_MAIN_ENTRYPOINT_PATH = 'src/features/team-message-delivery/main/index.ts';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-owned paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('team message-persistence coordinator boundary', () => {
  it('keeps generic persistence inside team-message-delivery behind its public facade', () => {
    const coordinator = source(COORDINATOR_PATH);
    const ports = source(PORTS_PATH);
    const featureComposition = source(FEATURE_COMPOSITION_PATH);
    const featureMainEntrypoint = source(FEATURE_MAIN_ENTRYPOINT_PATH);

    expect(existsSync(resolve(process.cwd(), LEGACY_COORDINATOR_PATH))).toBe(false);
    expect(coordinator).toContain('export class TeamMessagePersistenceCoordinator');
    expect(coordinator).toContain('implements TeamMessagePersistenceFacade');
    expect(coordinator).not.toMatch(
      /(?:agent-teams-controller|TeamDataService|TeamInboxWriter|TeamConfigReader|OpenCode|opencode|Claude|Codex)/
    );
    expect(ports).toContain('export interface TeamMessagePersistenceCoordinatorPorts');
    expect(ports).toContain('export interface TeamMessagePersistenceFacade');
    expect(ports).toContain('export interface TeamMessageSystemNotificationPort');
    expect(ports).not.toContain('@shared/types');
    expect(featureComposition).toContain('new TeamMessagePersistenceCoordinator(ports)');
    expect(featureMainEntrypoint).toContain('createTeamMessagePersistenceFacade');
    expect(featureMainEntrypoint).not.toMatch(/\bTeamMessagePersistenceCoordinator\b/);
  });

  it('keeps TeamDataService as a facade while legacy composition owns the retained adapter wiring', () => {
    const service = source(SERVICE_PATH);
    const composition = source(SERVICE_COMPOSITION_PATH);
    const legacyComposition = source(LEGACY_COMPOSITION_PATH);

    expect(service).toContain("from '@features/team-message-delivery/main'");
    expect(service).toContain('readonly messagePersistence: TeamMessagePersistenceFacade');
    expect(service).not.toContain('createTeamMessagePersistenceFacade');
    expect(service).not.toContain('./TeamMessagePersistenceCoordinator');
    expect(legacyComposition).toContain("from '@features/team-message-delivery/main'");
    expect(legacyComposition).toContain('createTeamMessagePersistenceFacade');
    expect(legacyComposition).toContain('controllerPersistence:');
    expect(legacyComposition).toContain('controllerCapabilities.messagePersistence.sendMessage');
    expect(legacyComposition).not.toMatch(
      /(?:TeamMessagePersistenceCoordinator|OpenCode|opencode|TeamProvisioningService|team-runtime-control)/
    );
    expect(composition).toContain("from '@features/team-message-delivery/main'");
    expect(composition).toContain('messagePersistence: TeamMessagePersistenceFacade');
    expect(composition).toContain('ports.messagePersistence.resolveLeadRuntimeContext(teamName)');
    expect(composition).not.toMatch(/\bTeamMessagePersistenceCoordinator\b/);
    expect(composition).not.toContain('createTeamMessagePersistenceFacade');
  });
});
