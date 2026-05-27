import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";

import { AuthenticateDesktopClientUseCase } from "@agent-teams-control-plane/features-workspace-identity";
import {
  extractDesktopBearerToken,
  type DesktopAuthRequestLike,
} from "@agent-teams-control-plane/features-workspace-identity/interface/nest";

import { GetGitHubActionStatusUseCase } from "../../application/use-cases/get-github-action-status.use-case.js";
import { RequestGitHubActionUseCase } from "../../application/use-cases/request-github-action.use-case.js";

@Controller("api/desktop/v1/github-actions")
export class GitHubActionsController {
  public constructor(
    @Inject(AuthenticateDesktopClientUseCase)
    private readonly authenticateDesktopClient: AuthenticateDesktopClientUseCase,
    @Inject(RequestGitHubActionUseCase)
    private readonly requestGitHubAction: RequestGitHubActionUseCase,
    @Inject(GetGitHubActionStatusUseCase)
    private readonly getGitHubActionStatus: GetGitHubActionStatusUseCase,
  ) {}

  @Post()
  public async requestAction(
    @Body() body: unknown,
    @Req() request: DesktopAuthRequestLike,
  ) {
    const actor = await this.authenticateDesktopClient.require(
      extractDesktopBearerToken(request),
    );
    const requestBody = readRecord(body);
    const requestedBy = readRecord(requestBody.requestedBy);
    const attribution = readRecord(requestBody.attribution);
    return this.requestGitHubAction.execute({
      actionType: readString(requestBody.actionType),
      actor,
      attribution: {
        agentDisplayName: readString(attribution.agentDisplayName),
        ...(typeof attribution.agentAvatarUrl === "string"
          ? { agentAvatarUrl: attribution.agentAvatarUrl }
          : {}),
        ...(typeof attribution.teamDisplayName === "string"
          ? { teamDisplayName: attribution.teamDisplayName }
          : {}),
      },
      payload: requestBody.payload,
      requestId: readString(requestBody.requestId),
      requestedBy: {
        subjectId: readString(requestedBy.subjectId),
        subjectKind: readString(requestedBy.subjectKind),
        ...(typeof requestedBy.agentId === "string"
          ? { agentId: requestedBy.agentId }
          : {}),
        ...(typeof requestedBy.teamId === "string" ? { teamId: requestedBy.teamId } : {}),
      },
      targetId: readString(requestBody.targetId),
      ...(typeof requestBody.correlationId === "string"
        ? { correlationId: requestBody.correlationId }
        : {}),
    });
  }

  @Get(":actionRequestId")
  public async status(
    @Param("actionRequestId") actionRequestId: string,
    @Req() request: DesktopAuthRequestLike,
  ) {
    const actor = await this.authenticateDesktopClient.require(
      extractDesktopBearerToken(request),
    );
    return this.getGitHubActionStatus.execute({
      actionRequestId,
      actor,
    });
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
