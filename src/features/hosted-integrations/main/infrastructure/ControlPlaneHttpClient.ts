import {
  normalizeHostedGitHubActionStatus,
  normalizeHostedGitHubAvailableRepository,
  normalizeHostedGitHubConnection,
  normalizeHostedGitHubRepositoryTarget,
  normalizeHostedGitHubSetupSession,
  normalizeHostedSafeError,
} from '../../contracts';
import {
  assertTokenBearingRequestUrl,
  hostedIntegrationError,
  normalizeControlPlaneBaseUrl,
  throwHostedIntegrationError,
} from '../../core/domain';

import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  HostedGitHubActionRequestEnvelopeDto,
  HostedGitHubActionStatusDto,
  HostedGitHubAvailableRepositoryDto,
  HostedGitHubConnectionDto,
  HostedGitHubRepositoryTargetDto,
  HostedGitHubSetupSessionDto,
  HostedIntegrationDesktopSessionDto,
  ListAvailableHostedGitHubRepositoriesRequestDto,
  StartHostedPairingResponseDto,
} from '../../contracts';
import type {
  ControlPlaneAgentActionPort,
  ControlPlaneConnectionPort,
  ControlPlaneGithubSetupPort,
  ControlPlaneGithubTargetsPort,
  ControlPlanePairingPort,
} from '../../core/application';
import type { NormalizedControlPlaneBaseUrl } from '../../core/domain';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 512 * 1024;

type FetchLike = typeof fetch;

export interface ControlPlaneHttpClientOptions {
  readonly getBaseUrl: () => Promise<string | undefined>;
  readonly allowLocalhostHttp?: boolean;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly responseLimitBytes?: number;
}

export class ControlPlaneHttpClient
  implements
    ControlPlaneAgentActionPort,
    ControlPlaneConnectionPort,
    ControlPlaneGithubSetupPort,
    ControlPlaneGithubTargetsPort,
    ControlPlanePairingPort
{
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly responseLimitBytes: number;

  public constructor(private readonly options: ControlPlaneHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.responseLimitBytes = options.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  }

  public async getMe(token: string): Promise<HostedIntegrationDesktopSessionDto> {
    return normalizeDesktopSession(await this.request('GET', '/api/desktop/v1/me', { token }));
  }

  public async bootstrapWorkspace(
    input: BootstrapHostedWorkspaceRequestDto
  ): Promise<{ session: HostedIntegrationDesktopSessionDto; token: string }> {
    const response = await this.request('POST', '/api/desktop/v1/workspaces/bootstrap', {
      body: input,
      token: null,
    });
    const record = asRecord(response);
    const token = readRequiredString(record.desktopToken ?? record.token, 'desktopToken');
    return {
      session: normalizeDesktopSession(record),
      token,
    };
  }

  public async revokeSession(token: string, desktopClientId: string): Promise<void> {
    await this.request(
      'POST',
      `/api/desktop/v1/clients/${encodeURIComponent(desktopClientId)}/revoke`,
      { token }
    );
  }

  public async rotateSessionToken(
    token: string,
    desktopClientId: string,
    rotationRequestId: string
  ): Promise<{ token: string }> {
    const response = await this.request(
      'POST',
      `/api/desktop/v1/clients/${encodeURIComponent(desktopClientId)}/rotate-token`,
      {
        body: { rotationRequestId },
        token,
      }
    );
    const record = asRecord(response);
    return {
      token: readRequiredString(record.desktopToken ?? record.token, 'desktopToken'),
    };
  }

  public async startPairing(token: string): Promise<StartHostedPairingResponseDto> {
    const response = asRecord(
      await this.request('POST', '/api/desktop/v1/pairing/start', { token })
    );
    return {
      expiresAt: readRequiredString(response.expiresAt, 'expiresAt'),
      pairingCode: readRequiredString(response.pairingCode, 'pairingCode'),
      pairingSessionId: readRequiredString(response.pairingSessionId, 'pairingSessionId'),
    };
  }

  public async completePairing(
    input: CompleteHostedPairingRequestDto
  ): Promise<{ session: HostedIntegrationDesktopSessionDto; token: string }> {
    const response = await this.request('POST', '/api/desktop/v1/pairing/complete', {
      body: input,
      token: null,
    });
    const record = asRecord(response);
    const token = readRequiredString(record.desktopToken ?? record.token, 'desktopToken');
    return {
      session: normalizeDesktopSession(record),
      token,
    };
  }

  public async startGitHubSetup(token: string): Promise<HostedGitHubSetupSessionDto> {
    return normalizeHostedGitHubSetupSession(
      await this.request('POST', '/api/desktop/v1/integrations/github/setup/start', { token })
    );
  }

  public async getGitHubSetupStatus(
    token: string,
    setupSessionId: string
  ): Promise<HostedGitHubSetupSessionDto> {
    return normalizeHostedGitHubSetupSession(
      await this.request(
        'GET',
        `/api/desktop/v1/integrations/github/setup/${encodeURIComponent(setupSessionId)}`,
        { token }
      ),
      setupSessionId
    );
  }

  public async listConnections(token: string): Promise<readonly HostedGitHubConnectionDto[]> {
    const response = await this.request('GET', '/api/desktop/v1/integrations/github/connections', {
      token,
    });
    const list = Array.isArray(response) ? response : asArray(asRecord(response).connections);
    return list.map(normalizeHostedGitHubConnection);
  }

  public async listAvailableRepositories(
    token: string,
    input: ListAvailableHostedGitHubRepositoriesRequestDto
  ): Promise<readonly HostedGitHubAvailableRepositoryDto[]> {
    const url = new URLSearchParams();
    if (input.pageSize) url.set('pageSize', String(input.pageSize));
    if (input.cursor) url.set('cursor', input.cursor);
    const query = url.toString();
    const path = `/api/desktop/v1/integrations/${encodeURIComponent(
      input.connectionId
    )}/repository-targets/available`;
    const response = await this.request('GET', query ? `${path}?${query}` : path, { token });
    const list = Array.isArray(response) ? response : asArray(asRecord(response).repositories);
    return list.map((item) => normalizeHostedGitHubAvailableRepository(item, input.connectionId));
  }

  public async listTargets(token: string): Promise<readonly HostedGitHubRepositoryTargetDto[]> {
    const response = await this.request('GET', '/api/desktop/v1/repository-targets', { token });
    const list = Array.isArray(response) ? response : asArray(asRecord(response).targets);
    return list.map(normalizeHostedGitHubRepositoryTarget);
  }

  public async enableTarget(
    token: string,
    input: EnableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto> {
    return normalizeHostedGitHubRepositoryTarget(
      await this.request(
        'POST',
        `/api/desktop/v1/integrations/${encodeURIComponent(input.connectionId)}/repository-targets`,
        {
          body: { githubRepositoryId: input.githubRepositoryId },
          token,
        }
      )
    );
  }

  public async disableTarget(
    token: string,
    input: DisableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto> {
    return normalizeHostedGitHubRepositoryTarget(
      await this.request(
        'POST',
        `/api/desktop/v1/repository-targets/${encodeURIComponent(input.targetId)}/disable`,
        {
          body: input.reason ? { reason: input.reason } : {},
          token,
        }
      )
    );
  }

  public async submitAgentGithubAction(
    token: string,
    envelope: HostedGitHubActionRequestEnvelopeDto
  ): Promise<HostedGitHubActionStatusDto> {
    return normalizeHostedGitHubActionStatus(
      await this.request('POST', '/api/desktop/v1/github-actions', {
        body: envelope,
        token,
      })
    );
  }

  public async getAgentGithubActionStatus(
    token: string,
    actionRequestId: string
  ): Promise<HostedGitHubActionStatusDto> {
    return normalizeHostedGitHubActionStatus(
      await this.request(
        'GET',
        `/api/desktop/v1/github-actions/${encodeURIComponent(actionRequestId)}`,
        { token }
      )
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { token: string | null; body?: unknown }
  ): Promise<unknown> {
    const baseUrl = await this.getBaseUrl();
    const requestUrl = assertTokenBearingRequestUrl(baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(requestUrl.href, {
        method,
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        throwHostedIntegrationError(
          hostedIntegrationError(
            'HOSTED_INTEGRATION_REDIRECT_REJECTED',
            'Control-plane request redirected unexpectedly.',
            'security'
          )
        );
      }

      const payload = await this.readJsonResponse(response);
      if (!response.ok) {
        throwHostedIntegrationError(normalizeHostedSafeError(payload));
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throwHostedIntegrationError(
          hostedIntegrationError(
            'HOSTED_INTEGRATION_REQUEST_TIMEOUT',
            'Control-plane request timed out.',
            'network'
          )
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getBaseUrl(): Promise<NormalizedControlPlaneBaseUrl> {
    const rawBaseUrl = await this.options.getBaseUrl();
    return normalizeControlPlaneBaseUrl(rawBaseUrl ?? '', {
      allowLocalhostHttp: this.options.allowLocalhostHttp === true,
    });
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > this.responseLimitBytes) {
      throwHostedIntegrationError(
        hostedIntegrationError(
          'HOSTED_INTEGRATION_RESPONSE_TOO_LARGE',
          'Control-plane response is too large.',
          'security'
        )
      );
    }
    const text = await response.text();
    if (text.length > this.responseLimitBytes) {
      throwHostedIntegrationError(
        hostedIntegrationError(
          'HOSTED_INTEGRATION_RESPONSE_TOO_LARGE',
          'Control-plane response is too large.',
          'security'
        )
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throwHostedIntegrationError(
        hostedIntegrationError(
          'HOSTED_INTEGRATION_RESPONSE_INVALID',
          'Control-plane response was not valid JSON.',
          'unavailable'
        )
      );
    }
  }
}

function normalizeDesktopSession(value: unknown): HostedIntegrationDesktopSessionDto {
  const input = asRecord(value);
  return {
    desktopClientId: readRequiredString(input.desktopClientId, 'desktopClientId'),
    desktopDisplayName: readOptionalString(input.desktopDisplayName),
    fetchedAt: new Date().toISOString(),
    state: 'paired',
    workspaceDisplayName: readOptionalString(input.workspaceDisplayName),
    workspaceId: readRequiredString(input.workspaceId, 'workspaceId'),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const normalized = readOptionalString(value);
  if (normalized) return normalized;
  throwHostedIntegrationError(
    hostedIntegrationError(
      'HOSTED_INTEGRATION_RESPONSE_FIELD_MISSING',
      'Control-plane response is missing a required field.',
      'unavailable',
      { field }
    )
  );
}
