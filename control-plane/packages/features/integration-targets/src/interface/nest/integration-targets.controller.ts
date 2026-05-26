import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";

import { createSafeError } from "@agent-teams-control-plane/shared";
import { AuthenticateDesktopClientUseCase } from "@agent-teams-control-plane/features-workspace-identity";
import {
  extractDesktopBearerToken,
  type DesktopAuthRequestLike,
} from "@agent-teams-control-plane/features-workspace-identity/interface/nest";

import {
  assertIntegrationTargetStatus,
  assertTargetPolicyCapability,
  assertTargetPolicyEffect,
  assertTargetPolicySubjectKind,
  type TargetPolicyRuleInput,
} from "../../domain/index.js";
import { DisableRepositoryTargetUseCase } from "../../application/use-cases/disable-repository-target.use-case.js";
import { EnableRepositoryTargetUseCase } from "../../application/use-cases/enable-repository-target.use-case.js";
import { EvaluateTargetPolicyUseCase } from "../../application/use-cases/evaluate-target-policy.use-case.js";
import { GetRepositoryTargetUseCase } from "../../application/use-cases/get-repository-target.use-case.js";
import { ListAvailableRepositoryTargetsUseCase } from "../../application/use-cases/list-available-repository-targets.use-case.js";
import { ListRepositoryTargetsUseCase } from "../../application/use-cases/list-repository-targets.use-case.js";
import { UpdateTargetPolicyUseCase } from "../../application/use-cases/update-target-policy.use-case.js";

@Controller("api/desktop/v1")
export class IntegrationTargetsController {
  public constructor(
    @Inject(AuthenticateDesktopClientUseCase)
    private readonly authenticateDesktopClient: AuthenticateDesktopClientUseCase,
    @Inject(ListAvailableRepositoryTargetsUseCase)
    private readonly listAvailableRepositoryTargets: ListAvailableRepositoryTargetsUseCase,
    @Inject(ListRepositoryTargetsUseCase)
    private readonly listRepositoryTargets: ListRepositoryTargetsUseCase,
    @Inject(GetRepositoryTargetUseCase)
    private readonly getRepositoryTarget: GetRepositoryTargetUseCase,
    @Inject(EnableRepositoryTargetUseCase)
    private readonly enableRepositoryTarget: EnableRepositoryTargetUseCase,
    @Inject(DisableRepositoryTargetUseCase)
    private readonly disableRepositoryTarget: DisableRepositoryTargetUseCase,
    @Inject(UpdateTargetPolicyUseCase)
    private readonly updateTargetPolicy: UpdateTargetPolicyUseCase,
    @Inject(EvaluateTargetPolicyUseCase)
    private readonly evaluateTargetPolicy: EvaluateTargetPolicyUseCase,
  ) {}

  @Get("integrations/:connectionId/repository-targets/available")
  public async listAvailable(
    @Req() request: DesktopAuthRequestLike,
    @Param("connectionId") connectionId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const actor = await this.authenticate(request);
    const filters = availableRepositoryFilters(query);
    const pagination = optionalPagination(query);
    return this.listAvailableRepositoryTargets.execute({
      actor,
      integrationConnectionId: connectionId,
      ...(filters === undefined ? {} : { filters }),
      ...(pagination === undefined ? {} : { pagination }),
    });
  }

  @Post("integrations/:connectionId/repository-targets")
  public async createTarget(
    @Req() request: DesktopAuthRequestLike,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.authenticate(request);
    const input = assertRecord(body);
    const initialPolicyRules = optionalPolicyRules(input.initialPolicyRules);
    return this.enableRepositoryTarget.execute({
      actor,
      githubRepositoryId: requiredString(input.githubRepositoryId, "githubRepositoryId"),
      ...(initialPolicyRules === undefined ? {} : { initialPolicyRules }),
      integrationConnectionId: connectionId,
    });
  }

  @Get("repository-targets")
  public async listTargets(
    @Req() request: DesktopAuthRequestLike,
    @Query() query: Record<string, unknown>,
  ) {
    const actor = await this.authenticate(request);
    const status = optionalTargetStatus(query.status);
    const pagination = optionalPagination(query);
    return {
      targets: await this.listRepositoryTargets.execute({
        actor,
        ...(status === undefined ? {} : { status }),
        ...(pagination === undefined ? {} : { pagination }),
      }),
    };
  }

  @Get("repository-targets/:targetId")
  public async getTarget(
    @Req() request: DesktopAuthRequestLike,
    @Param("targetId") targetId: string,
  ) {
    const actor = await this.authenticate(request);
    return this.getRepositoryTarget.execute({ actor, targetId });
  }

  @Post("repository-targets/:targetId/disable")
  public async disableTarget(
    @Req() request: DesktopAuthRequestLike,
    @Param("targetId") targetId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.authenticate(request);
    const input = body === undefined ? {} : assertRecord(body);
    return this.disableRepositoryTarget.execute({
      actor,
      targetId,
      ...optionalReason(input.reason),
    });
  }

  @Post("repository-targets/:targetId/enable")
  public async enableTarget(
    @Req() request: DesktopAuthRequestLike,
    @Param("targetId") targetId: string,
  ) {
    const actor = await this.authenticate(request);
    const target = await this.getRepositoryTarget.execute({ actor, targetId });
    return this.enableRepositoryTarget.execute({
      actor,
      githubRepositoryId: target.binding.githubRepositoryId,
      integrationConnectionId: target.target.integrationConnectionId,
    });
  }

  @Put("repository-targets/:targetId/policy")
  public async updatePolicy(
    @Req() request: DesktopAuthRequestLike,
    @Param("targetId") targetId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.authenticate(request);
    const input = assertRecord(body);
    return this.updateTargetPolicy.execute({
      actor,
      expectedPolicyVersion: requiredPositiveInteger(
        input.expectedPolicyVersion,
        "expectedPolicyVersion",
      ),
      policyRules: requiredPolicyRules(input.policyRules),
      targetId,
    });
  }

  @Post("repository-targets/:targetId/policy/evaluate")
  public async evaluatePolicy(
    @Req() request: DesktopAuthRequestLike,
    @Param("targetId") targetId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.authenticate(request);
    const input = assertRecord(body);
    const optionalSubjects = evaluatePolicyOptionalSubjects(input);
    return this.evaluateTargetPolicy.execute({
      actor,
      capability: requiredString(input.capability, "capability"),
      subjectId: requiredString(input.subjectId, "subjectId"),
      subjectKind: requiredString(input.subjectKind, "subjectKind"),
      targetId,
      ...optionalSubjects,
    });
  }

  private async authenticate(request: DesktopAuthRequestLike) {
    return this.authenticateDesktopClient.require(extractDesktopBearerToken(request));
  }
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_INVALID_REQUEST_BODY",
    message: "Request body must be an object.",
  });
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_INVALID_REQUEST_FIELD",
    message: "Request field is invalid.",
  });
}

function requiredString(value: unknown, field: string): string {
  const stringValue = optionalString(value);
  if (stringValue !== undefined) {
    return stringValue;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_REQUIRED_REQUEST_FIELD",
    message: "Required request field is missing.",
    safeDetails: { field },
  });
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(numberValue) && numberValue > 0) {
    return numberValue;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_INVALID_REQUEST_FIELD",
    message: "Request field is invalid.",
    safeDetails: { field },
  });
}

function optionalIntegerQuery(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw invalidQueryField(field);
  }
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (Number.isInteger(numberValue)) {
    return numberValue;
  }
  throw invalidQueryField(field);
}

function optionalBooleanQuery(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "true" || value === "1" || value === true) {
    return true;
  }
  if (value === "false" || value === "0" || value === false) {
    return false;
  }
  throw invalidQueryField("boolean");
}

function optionalTargetStatus(value: unknown): string | undefined {
  const status = optionalString(value);
  return status === undefined ? undefined : assertIntegrationTargetStatus(status);
}

function availableRepositoryFilters(query: Record<string, unknown>):
  | {
      available?: boolean;
      archived?: boolean;
      targetStatus?: string;
    }
  | undefined {
  const available = optionalBooleanQuery(query.available);
  const archived = optionalBooleanQuery(query.archived);
  const targetStatus = optionalTargetStatus(query.targetStatus);
  if (available === undefined && archived === undefined && targetStatus === undefined) {
    return undefined;
  }
  return {
    ...(available === undefined ? {} : { available }),
    ...(archived === undefined ? {} : { archived }),
    ...(targetStatus === undefined ? {} : { targetStatus }),
  };
}

function optionalReason(value: unknown): { reason?: string } {
  const reason = optionalString(value);
  return reason === undefined ? {} : { reason };
}

function optionalPagination(query: Record<string, unknown>):
  | {
      limit?: number;
      offset?: number;
    }
  | undefined {
  const limit = optionalIntegerQuery(query.limit, "limit");
  const offset = optionalIntegerQuery(query.offset, "offset");
  if (limit === undefined && offset === undefined) {
    return undefined;
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

function invalidQueryField(field: string) {
  return createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_INVALID_QUERY_FIELD",
    message: "Query field is invalid.",
    safeDetails: { field },
  });
}

function evaluatePolicyOptionalSubjects(input: Record<string, unknown>): {
  agentSubjectId?: string;
  desktopClientSubjectId?: string;
  teamSubjectId?: string;
} {
  const agentSubjectId = optionalString(input.agentSubjectId);
  const desktopClientSubjectId = optionalString(input.desktopClientSubjectId);
  const teamSubjectId = optionalString(input.teamSubjectId);
  return {
    ...(agentSubjectId === undefined ? {} : { agentSubjectId }),
    ...(desktopClientSubjectId === undefined ? {} : { desktopClientSubjectId }),
    ...(teamSubjectId === undefined ? {} : { teamSubjectId }),
  };
}

function optionalPolicyRules(
  value: unknown,
): readonly TargetPolicyRuleInput[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredPolicyRules(value);
}

function requiredPolicyRules(value: unknown): readonly TargetPolicyRuleInput[] {
  if (!Array.isArray(value)) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_POLICY_RULES_INVALID",
      message: "Policy rules must be an array.",
    });
  }
  return value.map((item) => {
    const record = assertRecord(item);
    return {
      capability: assertTargetPolicyCapability(record.capability),
      effect: assertTargetPolicyEffect(record.effect),
      subjectId: requiredString(record.subjectId, "subjectId"),
      subjectKind: assertTargetPolicySubjectKind(record.subjectKind),
    };
  });
}
