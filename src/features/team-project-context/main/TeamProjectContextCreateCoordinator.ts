import type {
  ResolvedTeamWorkContext,
  TeamWorkContextAddress,
} from './TeamProjectContextRuntimeResolver';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
} from '@shared/types';

interface TeamProjectContextCreatePorts {
  createLogicalDraft(request: TeamCreateRequest): Promise<void>;
  withLogicalTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  reserve(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext>;
  releaseUnusedReservation(
    teamName: string, executionTeamName: string, workContextId: string
  ): Promise<boolean>;
  assertOtherContextsStopped(teamName: string, executionTeamName: string): Promise<void>;
  ensurePhysicalDraft(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext>;
  createNativeTeam(
    request: TeamCreateRequest, onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  confirmReady(
    address: TeamWorkContextAddress, executionTeamName: string
  ): Promise<ResolvedTeamWorkContext>;
}

/**
 * A per-project team is a logical draft plus a native-compatible execution
 * team. The physical runtime always uses its own name; never spawn the logical
 * name and attempt to filter native task/chat writes after the fact.
 *
 * The native create API acknowledges spawn, not readiness. Only an explicit
 * ready signal can confirm the context index and unlock history reads.
 */
export class TeamProjectContextCreateCoordinator {
  constructor(private readonly ports: TeamProjectContextCreatePorts) {}

  async create(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    if (request.projectContextMode !== 'per_project') {
      throw new Error('Project-scoped team creation requires per_project mode');
    }
    if (!request.cwd?.trim()) throw new Error('Choose a project before launching the team');
    const projectPath = request.cwd;
    const address: TeamWorkContextAddress = {
      logicalTeamName: request.teamName,
      projectPath,
    };

    // Makes an app-owned logical team, never a native CLI team. The existing
    // creation command rejects duplicate user-visible team names.
    await this.ports.createLogicalDraft(request);

    return this.ports.withLogicalTeamLock(request.teamName, async () => {
      const reserved = await this.ports.reserve(address);
      if (!reserved.workContextId || !reserved.projectPath || reserved.mode !== 'per_project') {
        throw new Error('Expected a reserved project-specific team context');
      }
      const canonicalAddress: TeamWorkContextAddress = {
        logicalTeamName: request.teamName,
        projectPath: reserved.projectPath,
      };
      let begun = false;
      try {
        await this.ports.assertOtherContextsStopped(
          request.teamName, reserved.executionTeamName
        );
        const materialized = await this.ports.ensurePhysicalDraft(canonicalAddress);
        if (materialized.executionTeamName !== reserved.executionTeamName) {
          throw new Error('Project context changed during team creation');
        }
        const physicalRequest: TeamCreateRequest = {
          ...request,
          teamName: reserved.executionTeamName,
          cwd: reserved.projectPath,
          projectContextMode: 'shared',
        };
        const reportProgress = (progress: TeamProvisioningProgress): void => {
          const logicalProgress = { ...progress, teamName: request.teamName };
          if (progress.state === 'ready') {
            // A spawn ACK does not authorize history access; check native config,
            // task directory and profile ownership before publishing ready.
            void this.ports.confirmReady(canonicalAddress, reserved.executionTeamName)
              .then(() => onProgress(logicalProgress))
              .catch((error: unknown) => {
                onProgress({
                  ...logicalProgress,
                  state: 'failed',
                  message: 'Could not verify the new project context',
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            return;
          }
          onProgress(logicalProgress);
        };
        begun = true;
        return await this.ports.createNativeTeam(physicalRequest, reportProgress);
      } catch (error) {
        // Only a never-materialized, provably empty reservation can be freed.
        // Native runs or directories must be reconciled, never hidden/deleted.
        if (!begun) {
          await this.ports.releaseUnusedReservation(
            request.teamName, reserved.executionTeamName, reserved.workContextId
          ).catch(() => false);
        }
        throw error;
      }
    });
  }
}
