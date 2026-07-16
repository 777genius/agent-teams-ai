import { join } from "node:path";
import { z } from "zod";
import {
  isRunEventCompactionSafetyMode,
  isRunEventProviderKind,
  isRunEventType,
  type RunEventCompactionSafetyMode,
  type RunEventProviderKind,
  type RunEventRetentionPolicy,
  type RunEventType,
  type WorkerControlActor,
  type WorkerControlDeliveryMode,
  type WorkerControlIntent,
  type WorkerControlPriority,
} from "@vioxen/subscription-runtime/worker-core";
import type { WorkerLaunchAdmission } from "./application/project-control/worker-launch-spec";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { CodexGoalOutputFormat } from "./codex-goal-ops";
import { resolveCodexGoalJobRegistryRoot } from "./codex-goal-jobs";
import {
  booleanValue,
  numberValue,
  resolvePath,
  stringValue,
  stringsFromValue,
} from "./codex-goal-mcp-values";

export type GoalMcpArgs = {
  readonly jobId?: string;
  readonly configPath?: string;
  readonly jobRootDir?: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly workspacePath?: string;
  readonly promptPath?: string;
  readonly codexGoalObjective?: string;
  readonly taskId?: string;
  readonly accounts?: string | readonly string[];
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly progressHeartbeatMs?: number;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
  readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
  readonly executionEngine?: CodexGoalRunConfig["executionEngine"];
  readonly taskTimeoutMs?: number;
  readonly appServerStartupTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly editMode?: CodexGoalRunConfig["editMode"];
  readonly providerSandboxMode?: CodexGoalRunConfig["providerSandboxMode"];
  readonly accessBoundary?: CodexGoalRunConfig["accessBoundary"];
  readonly projectAccessScope?: CodexGoalRunConfig["projectAccessScope"];
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: CodexGoalRunConfig["networkAccess"];
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly workerReportMode?: CodexGoalRunConfig["workerReportMode"];
  readonly tmuxSession?: string;
  readonly cwd?: string;
  readonly logPath?: string;
  readonly outputFormat?: CodexGoalOutputFormat;
};

export type StartMcpArgs = GoalMcpArgs & {
  readonly registryRootDir?: string;
  readonly confirmStart?: boolean;
  readonly skipDoctor?: boolean;
  readonly forceStart?: boolean;
};

export type JobRegistryMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
};

export type JobOverviewMcpArgs = JobRegistryMcpArgs & {
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly limit?: number;
  readonly jobIdPrefix?: string;
};

export type JobWatchMcpArgs = JobOverviewMcpArgs & {
  readonly jobIds?: string | readonly string[];
  readonly continueSafeJobs?: boolean;
  readonly maxContinuesPerRun?: number;
  readonly skipDoctor?: boolean;
};

export type AgentRunWatchMcpArgs = JobOverviewMcpArgs & {
  readonly providerKind?: string;
  readonly jobId?: string;
  readonly jobIds?: string | readonly string[];
  readonly stateRootDir?: string;
  readonly runArtifactsRootDir?: string;
  readonly includeChangedFiles?: boolean;
  readonly includeLogTail?: boolean;
};

export type AgentRunEventsMcpArgs = AgentRunWatchMcpArgs & {
  readonly eventRootDir?: string;
  readonly cursor?: string;
  readonly type?: string | readonly string[];
  readonly types?: string | readonly string[];
};

export type AgentRunStateMcpArgs = AgentRunWatchMcpArgs & {
  readonly eventRootDir?: string;
};

export type AgentRunEventCompactionMcpArgs = JobRegistryMcpArgs & {
  readonly eventRootDir?: string;
  readonly keepEventsAfter?: string;
  readonly keepLatestEventsPerRun?: number;
  readonly compactDeliveredEvents?: boolean;
  readonly dropInvalidLines?: boolean;
  readonly safetyMode?: string;
  readonly confirmCompact?: boolean;
};

export type AgentRunProjectEventsMcpArgs = AgentRunEventsMcpArgs & {
  readonly hostId?: string;
};

export type JobIdMcpArgs = JobRegistryMcpArgs & {
  readonly jobId?: string;
};

export type JobCreateMcpArgs = GoalMcpArgs & JobIdMcpArgs & {
  readonly description?: string;
  readonly tags?: readonly string[] | string;
  readonly overwrite?: boolean;
};

export type JobUpdateMcpArgs = JobIdMcpArgs & Partial<JobCreateMcpArgs>;

export type ProjectControlMcpArgs = GoalMcpArgs & JobRegistryMcpArgs & {
  readonly controllerJobId?: string;
  readonly path?: string;
  readonly sourceWorkspacePath?: string;
  readonly baseBranch?: string;
  readonly sourceRef?: string;
  readonly expectedSourceCommit?: string;
  readonly newBranch?: string;
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly force?: boolean;
  readonly commitSha?: string;
  readonly confirmCreate?: boolean;
  readonly confirmCreateWorktree?: boolean;
  readonly confirmIntegrate?: boolean;
  readonly confirmUpdate?: boolean;
  readonly confirmPush?: boolean;
  readonly confirmStart?: boolean;
  readonly continuationAccounts?: string | readonly string[];
  readonly confirmStop?: boolean;
  readonly forceStart?: boolean;
  readonly forceStop?: boolean;
  readonly skipDoctor?: boolean;
  readonly note?: string;
  readonly overwrite?: boolean;
  readonly promptBody?: string;
  readonly confirmRefill?: boolean;
  readonly preStartAdmission?: WorkerLaunchAdmission;
  readonly confirmPreStartAdmission?: boolean;
  readonly confirmRepair?: boolean;
  readonly startWorker?: boolean;
  readonly workerRole?: string;
  readonly dependencyBootstrap?: string;
  readonly confirmDependencyBootstrap?: boolean;
  readonly operation?: string;
  readonly includeDetails?: boolean;
  readonly maxDebtItems?: number;
  readonly executionMode?: string;
  readonly operationId?: string;
  readonly includeResult?: boolean;
  readonly confirmRecoverOperations?: boolean;
  readonly producerJobId?: string;
  readonly requireCanonicalRemoteHead?: boolean;
  readonly captureReviewedOutput?: boolean;
  readonly reviewedOutputId?: string;
  readonly expectedPatchSha256?: string;
  readonly reviewDecision?: string;
  readonly reviewedBy?: string;
  readonly reviewReason?: string;
  readonly approvedFiles?: readonly string[] | string;
  readonly requiredChecks?: readonly unknown[];
  readonly terminalAttemptId?: string;
  readonly failureCategory?: string;
  readonly failureCode?: string;
  readonly confirmFailedNoOutput?: boolean;
  readonly preexistingWorkspacePatchPath?: string;
  readonly preexistingWorkspacePatchSha256?: string;
  readonly confirmPreexistingWorkspacePatch?: boolean;
  readonly merge?: {
    readonly sourceRemote?: string;
    readonly sourceBranch?: string;
    readonly sourceCommit?: string;
    readonly expectedTargetCommit?: string;
  };
};

export type ProjectControllerLaunchPlanMcpArgs = ProjectControlMcpArgs & {
  readonly providerKind?: string;
  readonly stateDir?: string;
  readonly sessionArtifactPath?: string;
  readonly claudePath?: string;
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[] | string;
  readonly mcpCwd?: string;
  readonly rawShellMode?: "disabled-by-provider" | "sandboxed-deny-rules-only";
  readonly maxGoalTurns?: number;
  readonly reason?: string;
  readonly deliveryAttemptId?: string;
};

export type JobLifecycleMcpArgs = JobIdMcpArgs & {
  readonly confirmContinue?: boolean;
  readonly confirmRecover?: boolean;
  readonly confirmStop?: boolean;
  readonly confirmPause?: boolean;
  readonly forceStart?: boolean;
  readonly forceStop?: boolean;
  readonly forcePause?: boolean;
  readonly skipDoctor?: boolean;
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly reason?: string;
};

export type JobBriefMcpArgs = JobIdMcpArgs & {
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly targetCommit?: string;
  readonly targetWorkspacePath?: string;
};

export type JobResultReconcileMcpArgs = JobBriefMcpArgs & {
  readonly forceWrite?: boolean;
  readonly preservePatch?: boolean;
};

export type JobDecisionMcpArgs = JobBriefMcpArgs & {
  readonly includeRegistryConflicts?: boolean;
};

export type JobHandoffMcpArgs = JobBriefMcpArgs & {
  readonly includeCliFallback?: boolean;
};

export type JobAccountPoolMcpArgs = JobIdMcpArgs & {
  readonly poolRootDir?: string;
  readonly account?: string;
};

export type WorkerControlMcpArgs = JobIdMcpArgs & {
  readonly intent?: WorkerControlIntent;
  readonly deliveryMode?: WorkerControlDeliveryMode;
  readonly body?: string;
  readonly createdBy?: WorkerControlActor;
  readonly callerKind?: WorkerControlActor;
  readonly callerActor?: WorkerControlActor;
  readonly callerId?: string;
  readonly priority?: WorkerControlPriority;
  readonly idempotencyKey?: string;
  readonly expiresAt?: string;
  readonly supersedesSignalIds?: string | readonly string[];
  readonly signalId?: string;
  readonly supersededBySignalId?: string;
  readonly reason?: string;
  readonly includeBodies?: boolean;
  readonly repair?: boolean;
  readonly acceptedStaleAfterMs?: number;
};

export type AccountPoolMcpArgs = {
  readonly poolRootDir?: string;
  readonly pool?: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly accounts?: string | readonly string[];
};

export function jobRegistryInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    registryRootDir: z.string().optional(),
    cwd: z.string().optional(),
  };
}

export function jobIdInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    ...jobRegistryInputSchema(),
    jobId: z.string().optional(),
  };
}

export function registryRootFromArgs(args: JobRegistryMcpArgs): string {
  return resolveCodexGoalJobRegistryRoot({
    ...(args.registryRootDir ? { registryRootDir: args.registryRootDir } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  });
}

export function runEventRootFromArgs(
  args: AgentRunEventsMcpArgs,
  registryRootDir: string,
): string {
  const cwd = resolvePath(process.cwd(), stringValue(args.cwd) ?? process.cwd());
  return stringValue(args.eventRootDir)
    ? resolvePath(cwd, stringValue(args.eventRootDir) as string)
    : join(registryRootDir, ".run-events");
}

export function optionalRunEventProviderKind(
  value: unknown,
): RunEventProviderKind | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  if (isRunEventProviderKind(text)) return text;
  throw new Error(`unsupported run event provider kind: ${text}`);
}

export function runEventTypeFilter(args: AgentRunEventsMcpArgs): {
  readonly types?: readonly RunEventType[];
} {
  const values = [
    ...stringsFromValue(args.type),
    ...stringsFromValue(args.types),
  ];
  if (values.length === 0) return {};
  return {
    types: values.map((value) => {
      if (!isRunEventType(value)) {
        throw new Error(`unsupported run event type: ${value}`);
      }
      return value;
    }),
  };
}

export function runEventRetentionPolicyFromArgs(
  args: AgentRunEventCompactionMcpArgs,
): RunEventRetentionPolicy {
  const safetyMode = optionalRunEventCompactionSafetyMode(args.safetyMode);
  const keepEventsAfter = stringValue(args.keepEventsAfter);
  const keepLatestEventsPerRun = numberValue(args.keepLatestEventsPerRun);
  const compactDeliveredEvents = booleanValue(args.compactDeliveredEvents);
  const dropInvalidLines = booleanValue(args.dropInvalidLines);
  return {
    ...(safetyMode === undefined ? {} : { safetyMode }),
    ...(keepEventsAfter === undefined ? {} : { keepEventsAfter }),
    ...(keepLatestEventsPerRun === undefined ? {} : { keepLatestEventsPerRun }),
    ...(compactDeliveredEvents === undefined ? {} : { compactDeliveredEvents }),
    ...(dropInvalidLines === undefined ? {} : { dropInvalidLines }),
  };
}

function optionalRunEventCompactionSafetyMode(
  value: unknown,
): RunEventCompactionSafetyMode | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  if (isRunEventCompactionSafetyMode(text)) return text;
  throw new Error(`unsupported run event compaction safety mode: ${text}`);
}
