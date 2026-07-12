import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  AccessDecisionReason,
  LaunchPlanStatus,
  NetworkAccessMode,
  buildLaunchPlan,
  parseAccessBoundary,
  parseNetworkAccessMode,
  type LaunchAdapterCapabilities,
  type LaunchPlan,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

export type CodexGoalAccessConfig = {
  readonly accessBoundary?: AccessBoundary;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
};

export type CodexGoalAccessPlanConfig = CodexGoalAccessConfig & {
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
};

type BlockedLaunchPlan = Extract<
  LaunchPlan,
  { readonly status: LaunchPlanStatus.Blocked }
>;

export const codexGoalAccessBoundaryValues = Object.values(AccessBoundary);

export function optionalCodexGoalAccessBoundary(
  value: unknown,
  fieldName = "accessBoundary",
): AccessBoundary | undefined {
  return value === undefined ? undefined : parseAccessBoundary(value, fieldName);
}

export function optionalCodexGoalNetworkAccess(
  value: unknown,
  fieldName = "networkAccess",
): CodexGoalAccessConfig["networkAccess"] | undefined {
  if (value === undefined) return undefined;
  const parsed = parseNetworkAccessMode(value, fieldName);
  if (parsed === NetworkAccessMode.Unrestricted) {
    throw new Error(`${fieldName}_unrestricted_requires_danger_full_access`);
  }
  return parsed;
}

export function codexGoalControlsForAccessBoundary(
  config: CodexGoalAccessPlanConfig,
): Pick<ProviderTaskControls, "editMode" | "providerSandboxMode"> {
  assertDangerProviderSandboxUsesDangerBoundary(config);
  switch (config.accessBoundary) {
    case undefined:
      return {
        editMode: config.editMode ?? "allow-edits",
        ...(config.providerSandboxMode === undefined
          ? {}
          : { providerSandboxMode: config.providerSandboxMode }),
      };
    case AccessBoundary.ReadOnly:
      assertNoDangerProviderSandbox(config);
      return { editMode: "read-only" };
    case AccessBoundary.IsolatedWorkspaceWrite:
      assertNoDangerProviderSandbox(config);
      return {
        editMode: "allow-edits",
        providerSandboxMode: "workspace-write",
      };
    case AccessBoundary.ProjectScopedControl:
      throw new Error(
        "codex_goal_access_boundary_cannot_enforce_project_scoped_control",
      );
    case AccessBoundary.DangerFullAccess:
      if (config.allowDangerFullAccess !== true) {
        throw new Error("codex_goal_danger_full_access_requires_acknowledgement");
      }
      return {
        editMode: "allow-edits",
        providerSandboxMode: "danger-full-access",
      };
  }
  throw new Error("codex_goal_access_boundary_invalid");
}

export function buildCodexGoalAccessLaunchPlan(
  config: CodexGoalAccessPlanConfig,
): LaunchPlan | undefined {
  if (config.accessBoundary === undefined) return undefined;
  if (config.accessBoundary === AccessBoundary.ProjectScopedControl) {
    return {
      status: LaunchPlanStatus.Blocked,
      boundary: AccessBoundary.ProjectScopedControl,
      reason: AccessDecisionReason.CannotEnforceAccessBoundary,
      evidence: [
        "Codex ProjectScopedControl must use broker MCP tools, not an ordinary agent launch",
      ],
    };
  }
  const networkBlocker = codexGoalNetworkAccessBlocker(config);
  if (networkBlocker) return networkBlocker;
  return buildLaunchPlan({
    boundary: config.accessBoundary,
    ...(config.projectAccessScope === undefined
      ? {}
      : { scope: config.projectAccessScope }),
    adapter: codexGoalLaunchAdapterCapabilities,
    ...(config.allowDangerFullAccess === undefined
      ? {}
      : { allowDangerFullAccess: config.allowDangerFullAccess }),
    ...(config.networkAccess === undefined
      ? {}
      : { networkAccess: config.networkAccess }),
  });
}

export function assertCodexGoalAccessLaunchAllowed(
  config: CodexGoalAccessPlanConfig,
): LaunchPlan | undefined {
  const plan = buildCodexGoalAccessLaunchPlan(config);
  if (plan?.status === LaunchPlanStatus.Blocked) {
    throw new Error(
      `codex_goal_access_boundary_blocked:${plan.reason}:${plan.evidence.join(";")}`,
    );
  }
  codexGoalControlsForAccessBoundary(config);
  return plan;
}

export function assertCodexGoalStoredAccessBoundaryAllowed(
  config: CodexGoalAccessPlanConfig,
): LaunchPlan | undefined {
  assertDangerProviderSandboxUsesDangerBoundary(config);
  if (config.accessBoundary === undefined) return undefined;
  if (config.accessBoundary !== AccessBoundary.DangerFullAccess) {
    assertNoDangerProviderSandbox(config);
  }
  const networkBlocker = codexGoalNetworkAccessBlocker(config);
  if (networkBlocker) {
    throw new Error(
      `codex_goal_access_boundary_blocked:${networkBlocker.reason}:${networkBlocker.evidence.join(";")}`,
    );
  }
  const plan =
    config.accessBoundary === AccessBoundary.ProjectScopedControl
      ? buildLaunchPlan({
          boundary: AccessBoundary.ProjectScopedControl,
          ...(config.projectAccessScope === undefined
            ? {}
            : { scope: config.projectAccessScope }),
          adapter: codexGoalBrokeredProjectControlAdapterCapabilities,
          ...(config.networkAccess === undefined
            ? {}
            : { networkAccess: config.networkAccess }),
        })
      : buildCodexGoalAccessLaunchPlan(config);
  if (plan?.status === LaunchPlanStatus.Blocked) {
    throw new Error(
      `codex_goal_access_boundary_blocked:${plan.reason}:${plan.evidence.join(";")}`,
    );
  }
  if (config.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    codexGoalControlsForAccessBoundary(config);
  }
  return plan;
}

export function parseCodexGoalProjectAccessScope(
  value: unknown,
  fieldName = "projectAccessScope",
): ProjectAccessScope | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${fieldName}_invalid`);
  const projectId = requiredString(value.projectId, `${fieldName}.projectId`);
  return {
    projectId,
    ...(stringValue(value.projectSlug) === undefined
      ? {}
      : { projectSlug: stringValue(value.projectSlug) as string }),
    ...stringArrayProperty(value.readRoots, "readRoots", fieldName),
    ...stringArrayProperty(
      value.observedWorkspaceRoots,
      "observedWorkspaceRoots",
      fieldName,
    ),
    ...stringArrayProperty(
      value.consumedOutputLedgerRoots,
      "consumedOutputLedgerRoots",
      fieldName,
    ),
    ...(value.commitIdentity === undefined
      ? {}
      : { commitIdentity: parseCommitIdentity(value.commitIdentity, `${fieldName}.commitIdentity`) }),
    ...(stringValue(value.isolatedWorkspaceRoot) === undefined
      ? {}
      : {
          isolatedWorkspaceRoot: stringValue(
            value.isolatedWorkspaceRoot,
          ) as string,
        }),
    ...stringArrayProperty(value.workspaceRoots, "workspaceRoots", fieldName),
    ...stringArrayProperty(value.worktreeRoots, "worktreeRoots", fieldName),
    ...(stringValue(value.registryRoot) === undefined
      ? {}
      : { registryRoot: stringValue(value.registryRoot) as string }),
    ...(stringValue(value.authRoot) === undefined
      ? {}
      : { authRoot: stringValue(value.authRoot) as string }),
    ...stringArrayProperty(value.deniedRoots, "deniedRoots", fieldName),
    ...stringArrayProperty(value.jobIdPrefixes, "jobIdPrefixes", fieldName),
    ...stringArrayProperty(value.tmuxSessionPrefixes, "tmuxSessionPrefixes", fieldName),
    ...stringArrayProperty(value.allowedBranches, "allowedBranches", fieldName),
    ...stringArrayProperty(value.allowedGitRemotes, "allowedGitRemotes", fieldName),
    ...stringArrayProperty(value.allowedAccountIds, "allowedAccountIds", fieldName),
    ...(value.allowForcePush === undefined
      ? {}
      : { allowForcePush: booleanValue(value.allowForcePush, `${fieldName}.allowForcePush`) }),
    ...(value.preStartAdmission === undefined
      ? {}
      : {
          preStartAdmission: parseProjectPreStartAdmissionScope(
            value.preStartAdmission,
            `${fieldName}.preStartAdmission`,
          ),
        }),
  };
}

function parseProjectPreStartAdmissionScope(
  value: unknown,
  fieldName: string,
): NonNullable<ProjectAccessScope["preStartAdmission"]> {
  if (!isRecord(value)) throw new Error(`${fieldName}_invalid`);
  if (value.mode !== "serial") throw new Error(`${fieldName}.mode_invalid`);
  return {
    required: booleanValue(value.required, `${fieldName}.required`),
    mode: "serial",
    validatorBundle: parseProjectPreStartAdmissionValidators(
      value.validatorBundle,
      `${fieldName}.validatorBundle`,
    ),
  };
}

function parseProjectPreStartAdmissionValidators(
  value: unknown,
  fieldName: string,
): NonNullable<ProjectAccessScope["preStartAdmission"]>["validatorBundle"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName}_invalid`);
  }
  const validators = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${fieldName}.${index}_invalid`);
    const path = requiredString(entry.path, `${fieldName}.${index}.path`);
    const sha256 = requiredString(entry.sha256, `${fieldName}.${index}.sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${fieldName}.${index}.sha256_invalid`);
    }
    return { path, sha256 };
  });
  if (new Set(validators.map(({ path }) => path)).size !== validators.length) {
    throw new Error(`${fieldName}_duplicate_path`);
  }
  return validators;
}

function parseCommitIdentity(
  value: unknown,
  fieldName: string,
): NonNullable<ProjectAccessScope["commitIdentity"]> {
  if (!isRecord(value)) throw new Error(`${fieldName}_invalid`);
  return {
    name: requiredString(value.name, `${fieldName}.name`),
    email: requiredString(value.email, `${fieldName}.email`),
  };
}

export function parseCodexGoalProjectAccessScopeJson(
  value: string | undefined,
  fieldName = "projectAccessScope",
): ProjectAccessScope | undefined {
  if (value === undefined) return undefined;
  return parseCodexGoalProjectAccessScope(JSON.parse(value), fieldName);
}

const codexGoalLaunchAdapterCapabilities: LaunchAdapterCapabilities = {
  canEnforceFilesystemPolicy: true,
  canIsolateHome: true,
  canIsolateTemp: true,
  canDisableRawShell: false,
  canBrokerProjectControl: false,
  canRestrictNetwork: true,
};

const codexGoalBrokeredProjectControlAdapterCapabilities: LaunchAdapterCapabilities = {
  canEnforceFilesystemPolicy: true,
  canIsolateHome: true,
  canIsolateTemp: true,
  canDisableRawShell: true,
  canBrokerProjectControl: true,
  canRestrictNetwork: true,
};

function codexGoalNetworkAccessBlocker(
  config: CodexGoalAccessPlanConfig,
): BlockedLaunchPlan | null {
  if (
    config.accessBoundary === undefined ||
    config.accessBoundary === AccessBoundary.DangerFullAccess ||
    config.networkAccess === NetworkAccessMode.Restricted
  ) {
    return null;
  }
  return {
    status: LaunchPlanStatus.Blocked,
    boundary: config.accessBoundary,
    reason: AccessDecisionReason.CannotEnforceAccessBoundary,
    evidence: [
      'Codex goal adapter cannot enforce network_access=disabled; set networkAccess="restricted" until OS/container egress isolation exists',
    ],
  };
}

function assertNoDangerProviderSandbox(config: CodexGoalAccessPlanConfig): void {
  if (config.providerSandboxMode === "danger-full-access") {
    throw new Error("codex_goal_access_boundary_provider_sandbox_conflict");
  }
}

function assertDangerProviderSandboxUsesDangerBoundary(
  config: CodexGoalAccessPlanConfig,
): void {
  if (
    config.providerSandboxMode === "danger-full-access" &&
    config.accessBoundary !== AccessBoundary.DangerFullAccess
  ) {
    throw new Error("codex_goal_danger_full_access_requires_access_boundary");
  }
}

function stringArrayProperty(
  value: unknown,
  key: keyof ProjectAccessScope,
  fieldName: string,
): Partial<ProjectAccessScope> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName}.${String(key)}_invalid`);
  }
  return { [key]: value } as Partial<ProjectAccessScope>;
}

function requiredString(value: unknown, fieldName: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${fieldName}_required`);
  return text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${fieldName}_invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
