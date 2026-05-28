import {
  assertHostedSetupUrlAllowed,
  buildTrustedAgentGithubActionEnvelope,
  hostedIntegrationError,
  normalizeControlPlaneBaseUrl,
  throwHostedIntegrationError,
} from '../domain';

import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  ConfigureHostedIntegrationRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  GetHostedGitHubActionStatusRequestDto,
  HostedGitHubActionCommandDto,
  HostedGitHubActionStatusDto,
  HostedGitHubAvailableRepositoryDto,
  HostedGitHubConnectionDto,
  HostedGitHubRepositoryTargetDto,
  HostedGitHubSetupSessionDto,
  HostedIntegrationStateDto,
  ListAvailableHostedGitHubRepositoriesRequestDto,
  OpenHostedGitHubSetupUrlRequestDto,
  RefreshGitHubSetupRequestDto,
  StartHostedPairingResponseDto,
} from '../../contracts';
import type { HostedIntegrationUseCasePorts } from './ports';

export interface HostedIntegrationUseCaseOptions {
  readonly allowLocalhostHttp?: boolean;
}

export class HostedIntegrationUseCases {
  public constructor(
    private readonly ports: HostedIntegrationUseCasePorts,
    private readonly options: HostedIntegrationUseCaseOptions = {}
  ) {}

  public async getState(): Promise<HostedIntegrationStateDto> {
    const state = await this.ports.stateStore.readState();
    if (!(await this.ports.tokenStore.isAvailable())) {
      return {
        ...state,
        availability: {
          ...state.availability,
          status: 'secure_store_unavailable',
          reason: hostedIntegrationError(
            'HOSTED_INTEGRATION_SECURE_STORE_UNAVAILABLE',
            'Secure local credential storage is unavailable.',
            'security'
          ),
        },
      };
    }
    return state;
  }

  public async configure(
    input: ConfigureHostedIntegrationRequestDto
  ): Promise<HostedIntegrationStateDto> {
    const currentState = await this.ports.stateStore.readState();
    const baseUrl = normalizeControlPlaneBaseUrl(input.controlPlaneBaseUrl, {
      allowLocalhostHttp: this.options.allowLocalhostHttp === true,
    });
    if (controlPlaneOriginChanged(currentState.controlPlaneBaseUrl, baseUrl.origin)) {
      await this.ports.tokenStore.clearToken();
      await this.ports.stateStore.markSessionRevoked();
    }
    await this.ports.stateStore.saveControlPlaneBaseUrl(baseUrl);
    return this.getState();
  }

  public async bootstrapWorkspace(
    input: BootstrapHostedWorkspaceRequestDto
  ): Promise<HostedIntegrationStateDto> {
    await this.assertSecureStoreAvailable();
    const result = await this.ports.connection.bootstrapWorkspace(input);
    await this.ports.tokenStore.writeToken(result.token);
    await this.ports.stateStore.saveSession(result.session);
    return this.refreshAfterAuthChange(result.token);
  }

  public async startPairing(): Promise<StartHostedPairingResponseDto> {
    const token = await this.requireToken();
    return this.ports.pairing.startPairing(token);
  }

  public async completePairing(
    input: CompleteHostedPairingRequestDto
  ): Promise<HostedIntegrationStateDto> {
    await this.assertSecureStoreAvailable();
    const result = await this.ports.pairing.completePairing(input);
    await this.ports.tokenStore.writeToken(result.token);
    await this.ports.stateStore.saveSession(result.session);
    return this.refreshAfterAuthChange(result.token);
  }

  public async startGitHubSetup(): Promise<HostedGitHubSetupSessionDto> {
    const token = await this.requireToken();
    const setup = await this.ports.setup.startGitHubSetup(token);
    await this.ports.stateStore.saveSetupSession(setup);
    return setup;
  }

  public async refreshGitHubSetup(
    input: RefreshGitHubSetupRequestDto
  ): Promise<HostedGitHubSetupSessionDto> {
    const token = await this.requireToken();
    const setup = await this.ports.setup.getGitHubSetupStatus(token, input.setupSessionId);
    await this.ports.stateStore.saveSetupSession(setup);
    return setup;
  }

  public async dismissGitHubSetup(
    input: RefreshGitHubSetupRequestDto
  ): Promise<HostedIntegrationStateDto> {
    const state = await this.ports.stateStore.readState();
    if (state.activeSetup?.setupSessionId !== input.setupSessionId) return state;
    await this.ports.stateStore.saveSetupSession(null);
    return this.ports.stateStore.readState();
  }

  public async openSetupUrl(
    input: OpenHostedGitHubSetupUrlRequestDto
  ): Promise<{ opened: boolean }> {
    const state = await this.ports.stateStore.readState();
    if (!state.controlPlaneBaseUrl) {
      throwHostedIntegrationError(
        hostedIntegrationError(
          'HOSTED_INTEGRATION_BASE_URL_REQUIRED',
          'Control-plane URL is required before opening setup.',
          'configuration'
        )
      );
    }
    const baseUrl = normalizeControlPlaneBaseUrl(state.controlPlaneBaseUrl, {
      allowLocalhostHttp: this.options.allowLocalhostHttp === true,
    });
    const setupUrl = assertHostedSetupUrlAllowed(baseUrl, input.setupUrl);
    await this.ports.browserOpen.openExternal(setupUrl);
    return { opened: true };
  }

  public async refreshConnections(): Promise<readonly HostedGitHubConnectionDto[]> {
    const token = await this.requireToken();
    const connections = await this.ports.targets.listConnections(token);
    await this.ports.stateStore.saveConnections(connections);
    return connections;
  }

  public async listAvailableRepositories(
    input: ListAvailableHostedGitHubRepositoriesRequestDto
  ): Promise<readonly HostedGitHubAvailableRepositoryDto[]> {
    const token = await this.requireToken();
    return this.ports.targets.listAvailableRepositories(token, input);
  }

  public async listTargets(): Promise<readonly HostedGitHubRepositoryTargetDto[]> {
    const token = await this.requireToken();
    const targets = await this.ports.targets.listTargets(token);
    await this.ports.stateStore.saveTargets(targets);
    return targets;
  }

  public async enableTarget(
    input: EnableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto> {
    const token = await this.requireToken();
    const target = await this.ports.targets.enableTarget(token, input);
    await this.ports.stateStore.saveTargets(await this.ports.targets.listTargets(token));
    return target;
  }

  public async disableTarget(
    input: DisableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto> {
    const token = await this.requireToken();
    const target = await this.ports.targets.disableTarget(token, input);
    await this.ports.stateStore.saveTargets(await this.ports.targets.listTargets(token));
    return target;
  }

  public async submitAgentGithubAction(
    input: HostedGitHubActionCommandDto
  ): Promise<HostedGitHubActionStatusDto> {
    const token = await this.requireToken();
    await this.assertTargetEnabledForSubmission(token, input.targetId);
    const requestId = await this.ports.idGenerator.stableActionRequestId(input);
    const envelope = buildTrustedAgentGithubActionEnvelope({ ...input, requestId });
    const status = await this.ports.actions.submitAgentGithubAction(token, envelope);
    await this.ports.stateStore.saveActionStatus(status);
    return status;
  }

  public async getActionStatus(
    input: GetHostedGitHubActionStatusRequestDto
  ): Promise<HostedGitHubActionStatusDto> {
    const token = await this.requireToken();
    const status = await this.ports.actions.getAgentGithubActionStatus(
      token,
      input.actionRequestId
    );
    await this.ports.stateStore.saveActionStatus(status);
    return status;
  }

  public async revokeSession(): Promise<HostedIntegrationStateDto> {
    const state = await this.ports.stateStore.readState();
    const token = await this.ports.tokenStore.readToken();
    if (token && state.session?.desktopClientId) {
      await this.ports.connection.revokeSession(token, state.session.desktopClientId);
    }
    await this.ports.tokenStore.clearToken();
    await this.ports.stateStore.markSessionRevoked();
    return this.ports.stateStore.readState();
  }

  public async rotateSessionToken(): Promise<HostedIntegrationStateDto> {
    await this.assertSecureStoreAvailable();
    const state = await this.ports.stateStore.readState();
    const token = await this.requireToken();
    const desktopClientId = state.session?.desktopClientId?.trim();
    if (!desktopClientId) {
      throwHostedIntegrationError(
        hostedIntegrationError(
          'HOSTED_INTEGRATION_SESSION_REQUIRED',
          'Hosted integration is not connected.',
          'auth'
        )
      );
    }
    const rotation = await this.ports.connection.rotateSessionToken(
      token,
      desktopClientId,
      buildRotationRequestId(desktopClientId, this.ports.clock.now())
    );
    await this.ports.tokenStore.writeToken(rotation.token);
    return this.refreshAfterAuthChange(rotation.token);
  }

  private async refreshAfterAuthChange(tokenOverride?: string): Promise<HostedIntegrationStateDto> {
    const token = tokenOverride ?? (await this.requireToken());
    const session = await this.ports.connection.getMe(token);
    await this.ports.stateStore.saveSession(session);
    await this.refreshConnections().catch(() => []);
    await this.listTargets().catch(() => []);
    return this.ports.stateStore.readState();
  }

  private async assertTargetEnabledForSubmission(token: string, targetId: string): Promise<void> {
    const targets = await this.ports.targets.listTargets(token);
    await this.ports.stateStore.saveTargets(targets);
    const target = targets.find((item) => item.targetId === targetId.trim());
    if (target?.status === 'enabled') return;
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_GITHUB_ACTION_TARGET_NOT_ENABLED',
        'GitHub repository target is not enabled for hosted agent actions.',
        'validation',
        { targetId: targetId.trim() }
      )
    );
  }

  private async assertSecureStoreAvailable(): Promise<void> {
    if (await this.ports.tokenStore.isAvailable()) return;
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_SECURE_STORE_UNAVAILABLE',
        'Secure local credential storage is unavailable.',
        'security'
      )
    );
  }

  private async requireToken(): Promise<string> {
    const token = await this.ports.tokenStore.readToken();
    if (token?.trim()) return token;
    throwHostedIntegrationError(
      hostedIntegrationError(
        'HOSTED_INTEGRATION_SESSION_REQUIRED',
        'Hosted integration is not connected.',
        'auth'
      )
    );
  }
}

function controlPlaneOriginChanged(
  previousBaseUrl: string | undefined,
  nextOrigin: string
): boolean {
  if (!previousBaseUrl) return false;
  try {
    return new URL(previousBaseUrl).origin !== nextOrigin;
  } catch {
    return true;
  }
}

function buildRotationRequestId(desktopClientId: string, now: Date): string {
  return `desktop-token-rotation:${desktopClientId}:${now.toISOString()}`;
}
