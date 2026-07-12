import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionArtifact } from "@vioxen/subscription-runtime/core";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import {
  createLocalClaudeControlledAgentProvider,
  loadScopedClaudeSessionArtifact,
} from "@vioxen/subscription-runtime/worker-local";
import {
  RunEventProviderKind,
  type ControlledAgentProviderPort,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { CodexControlledAgentProvider } from "./controlled-agent";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import {
  selectProjectControllerCodexAccountSlot,
} from "./application/project-control/codex-goal-project-controller-account-selection";
import type { ProjectControllerOptions } from "./application/project-control/codex-goal-project-controller-options";
import {
  projectControllerPendingGuidancePromptContext,
} from "./application/project-control/codex-goal-project-controller-guidance";
import {
  type ProjectControllerProfile,
} from "./application/project-control/codex-goal-project-controller-profile";
import {
  codexGoalStateRootDir,
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./application/codex-goal-worker-control";
import { listCodexGoalAccountStatuses } from "./codex-goal-ops";

type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControllerProvider(input: {
  readonly options: ProjectControllerOptions;
  readonly controller: {
    readonly controller: CodexGoalJobManifest;
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
  };
  readonly launch: CodexGoalLaunchInput;
  readonly profile: ProjectControllerProfile;
  readonly state: {
    readonly cwd: string;
  };
}): Promise<{
  readonly provider: ControlledAgentProviderPort;
  readonly account?: JsonObject;
  readonly sessionArtifact?: JsonObject;
  readonly safeMessage: string;
}> {
  if (input.profile.providerKind === RunEventProviderKind.Claude) {
    const loaded = await controlledAgentClaudeSessionArtifact(input);
    const controllerObjective = await projectControllerObjectiveWithPendingGuidance(
      input.controller,
      input.launch,
    );
    return {
      provider: createLocalClaudeControlledAgentProvider({
        profile: input.profile,
        sessionArtifact: loaded.sessionArtifact,
        workspacePath: input.launch.config.workspacePath,
        ...(input.options.claudePath === undefined
          ? {}
          : { claudePath: input.options.claudePath }),
        ...(input.launch.config.model === undefined
          ? {}
          : { model: input.launch.config.model }),
        ...(input.options.maxGoalTurns === undefined
          ? {}
          : { maxTurns: input.options.maxGoalTurns }),
        controllerObjective,
      }),
      sessionArtifact: {
        path: loaded.path,
        sha256Prefix: loaded.sha256Prefix,
      },
      safeMessage:
        "Claude broker-only controlled-agent provider started with strict MCP broker tools.",
    };
  }

  const account = await controlledAgentCodexAccount({
    controller: input.controller,
    launch: input.launch,
  });
  const controllerObjective = await projectControllerObjectiveWithPendingGuidance(
    input.controller,
    input.launch,
  );
  return {
    provider: new CodexControlledAgentProvider({
      profile: input.profile,
      sessionArtifact: account.sessionArtifact,
      workspacePath: input.launch.config.workspacePath,
      codexBinaryPath: input.launch.config.codexBinaryPath ?? "codex",
      controllerObjective,
      controllerRegistryRootDir: input.controller.registryRootDir,
      ...(input.launch.config.model === undefined
        ? {}
        : { model: input.launch.config.model }),
      ...(input.launch.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.launch.config.reasoningEffort }),
      ...(input.launch.config.serviceTier === undefined
        ? {}
        : { serviceTier: input.launch.config.serviceTier }),
      ...(input.options.maxGoalTurns === undefined
        ? {}
        : { maxGoalTurns: input.options.maxGoalTurns }),
    }),
    account: {
      name: account.name,
      ...(account.authJsonSha256Prefix === undefined
        ? {}
        : { authJsonSha256Prefix: account.authJsonSha256Prefix }),
    },
    safeMessage:
      "Codex broker-only controlled-agent provider started with native app-server environments disabled.",
  };
}

async function projectControllerObjectiveWithPendingGuidance(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string> {
  const baseObjective = await readFile(launch.config.promptPath, "utf8");
  const guidanceContext = await projectControllerPendingGuidanceContext(controller, launch);
  return guidanceContext === undefined
    ? baseObjective
    : `${baseObjective}\n\n${guidanceContext}`;
}

async function projectControllerPendingGuidanceContext(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string | undefined> {
  try {
    const control = codexGoalWorkerControlService(launch);
    const target = codexGoalWorkerControlTarget({
      manifest: controller.controller,
      launch,
    });
    const decision = await control.getDecision({ target });
    return projectControllerPendingGuidancePromptContext({
      pendingCount: decision.pendingSignals.length,
      deliverableSignals: decision.deliverableSignals,
    });
  } catch {
    return undefined;
  }
}


async function controlledAgentCodexAccount(input: {
  readonly controller: {
    readonly scope: ProjectAccessScope;
  };
  readonly launch: CodexGoalLaunchInput;
}): Promise<{
  readonly name: string;
  readonly authJsonSha256Prefix?: string;
  readonly sessionArtifact: SessionArtifact;
}> {
  if (!input.controller.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  if (resolve(input.launch.config.authRootDir) !== resolve(input.controller.scope.authRoot)) {
    throw new Error("project_control_controller_auth_root_outside_scope");
  }
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.launch.config.authRootDir,
    accounts: input.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(input.launch),
  });
  const selected = selectProjectControllerCodexAccountSlot({
    slots,
    allowedAccountIds: input.controller.scope.allowedAccountIds,
  });
  if (!selected) {
    throw new Error("project_control_controller_no_available_account");
  }
  const authJsonBytes = await readFile(selected.authJsonPath, "utf8");
  return {
    name: selected.name,
    ...(selected.authJsonSha256Prefix === undefined
      ? {}
      : { authJsonSha256Prefix: selected.authJsonSha256Prefix }),
    sessionArtifact: sessionArtifactFromCodexAuthJson(authJsonBytes),
  };
}

async function controlledAgentClaudeSessionArtifact(input: {
  readonly options: ProjectControllerOptions;
  readonly controller: {
    readonly scope: ProjectAccessScope;
  };
  readonly state: {
    readonly cwd: string;
  };
}): Promise<{
  readonly path: string;
  readonly sha256Prefix: string;
  readonly sessionArtifact: SessionArtifact;
}> {
  if (!input.controller.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  const rawPath = input.options.sessionArtifactPath;
  if (rawPath === undefined) {
    throw new Error("project_control_controller_session_artifact_path_required");
  }
  return loadScopedClaudeSessionArtifact({
    sessionArtifactPath: rawPath,
    authRoot: input.controller.scope.authRoot,
    cwd: input.state.cwd,
  });
}
