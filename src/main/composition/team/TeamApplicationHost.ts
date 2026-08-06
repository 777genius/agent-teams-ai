import type {
  TeamApplicationHostPorts,
  TeamApplicationLaunchResult,
  TeamApplicationView,
  TeamLaunchRequestBranches,
} from './TeamApplicationHostPorts';
import type {
  TeamCreateConfigRequest,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
} from '@shared/types/team';

const noProgress = (_progress: TeamProvisioningProgress): void => undefined;

export class TeamApplicationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamApplicationUnavailableError';
  }
}

/**
 * Provider-neutral application sequencing shared by the team HTTP routes.
 *
 * Process supervision and provider execution remain owned by the injected
 * capabilities. This host only coordinates the application-visible effects
 * around those existing owners.
 */
export class TeamApplicationHost {
  constructor(private readonly ports: TeamApplicationHostPorts) {}

  async listTeams(): Promise<TeamSummary[]> {
    return this.requireData().listTeams();
  }

  async createTeamDraft(request: TeamCreateConfigRequest): Promise<void> {
    await this.requireData().createTeamConfig(request);
    this.ports.resume?.resumeTeam(request.teamName);
  }

  async getTeam(teamName: string): Promise<TeamApplicationView> {
    const savedRequest = await this.findDraftSavedRequest(teamName);
    if (savedRequest) {
      return {
        teamName,
        pendingCreate: true,
        savedRequest,
      };
    }

    await this.ports.taskActivity?.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName);
    const data = await this.requireData().getTeamData(teamName);
    const runtime = this.ports.runtime;
    if (!runtime) {
      return data;
    }

    try {
      const runtimeState = await runtime.getRuntimeState(teamName);
      return typeof runtimeState.isAlive === 'boolean'
        ? { ...data, isAlive: runtimeState.isAlive }
        : data;
    } catch {
      return data;
    }
  }

  async launchTeam(
    teamName: string,
    requests: TeamLaunchRequestBranches
  ): Promise<TeamApplicationLaunchResult> {
    const savedRequest = await this.findDraftSavedRequest(teamName);
    const provisioning = this.requireProvisioningStart();
    const response = savedRequest
      ? await provisioning.createTeam(requests.createFromDraft(savedRequest), noProgress)
      : await provisioning.launchTeam(requests.resumeExisting(), noProgress);

    if (savedRequest) {
      this.ports.resume?.resumeTeam(teamName);
    }
    this.ports.listInvalidation.invalidate();
    return response;
  }

  async stopTeam(teamName: string): Promise<TeamRuntimeState> {
    const runtime = this.requireRuntime();
    await runtime.stopTeam(teamName);
    return runtime.getRuntimeState(teamName);
  }

  async getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    return this.requireRuntime().getRuntimeState(teamName);
  }

  async getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress> {
    const status = this.ports.provisioningStatus;
    if (!status) {
      throw new TeamApplicationUnavailableError(
        'Team provisioning status is not available in this mode'
      );
    }
    return status.getProvisioningStatus(runId);
  }

  async listAliveRuntimeStates(): Promise<TeamRuntimeState[]> {
    const runtime = this.requireRuntime();
    return Promise.all(
      runtime.getAliveTeams().map((teamName) => runtime.getRuntimeState(teamName))
    );
  }

  async recordRuntimeBootstrapCheckin(payload: unknown) {
    return this.requireRuntimeIngress().recordRuntimeBootstrapCheckin(payload);
  }

  async deliverRuntimeMessage(payload: unknown) {
    return this.requireRuntimeIngress().deliverRuntimeMessage(payload);
  }

  async recordRuntimeTaskEvent(payload: unknown) {
    return this.requireRuntimeIngress().recordRuntimeTaskEvent(payload);
  }

  async recordRuntimeHeartbeat(payload: unknown) {
    return this.requireRuntimeIngress().recordRuntimeHeartbeat(payload);
  }

  private async findDraftSavedRequest(teamName: string) {
    const data = this.ports.data;
    if (!data || (await this.ports.configPresence.hasConfig(teamName))) {
      return null;
    }
    return data.getSavedRequest(teamName);
  }

  private requireData() {
    const data = this.ports.data;
    if (!data) {
      throw new TeamApplicationUnavailableError('Team data control is not available in this mode');
    }
    return data;
  }

  private requireProvisioningStart() {
    const provisioning = this.ports.provisioningStart;
    if (!provisioning) {
      throw new TeamApplicationUnavailableError(
        'Team launch control is not available in this mode'
      );
    }
    return provisioning;
  }

  private requireRuntime() {
    const runtime = this.ports.runtime;
    if (!runtime) {
      throw new TeamApplicationUnavailableError(
        'Team runtime control is not available in this mode'
      );
    }
    return runtime;
  }

  private requireRuntimeIngress() {
    const runtimeIngress = this.ports.runtimeIngress;
    if (!runtimeIngress) {
      throw new TeamApplicationUnavailableError(
        'Team runtime ingress is not available in this mode'
      );
    }
    return runtimeIngress;
  }
}
