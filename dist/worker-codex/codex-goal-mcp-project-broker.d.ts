/// <reference types="node" />
import { ProjectControlBroker, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalJobManifest, type CodexGoalJobManifestInput } from "./codex-goal-jobs.js";
import { type CodexGoalLaunchInput } from "./codex-goal-ops.js";
import { type CodexProjectAdmissionDeps } from "./application/project-control/codex-goal-project-admission.js";
import { type CodexGoalProjectCreateWorktreeInput } from "./application/project-control/codex-goal-project-control-contracts.js";
export type { CodexGoalProjectCreateWorktreeInput, } from "./application/project-control/codex-goal-project-control-contracts.js";
export type CodexGoalProjectIntegrateCommitInput = {
    readonly workspacePath: string;
    readonly realWorkspacePath?: string;
    readonly branch: string;
    readonly commitSha: string;
};
export type CodexGoalProjectPushBranchInput = {
    readonly workspacePath: string;
    readonly realWorkspacePath?: string;
    readonly branch: string;
    readonly remote: string;
    readonly force: boolean;
};
export type CodexProjectControlBrokerInput = {
    readonly registryRootDir: string;
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
    readonly admissionDeps: CodexProjectAdmissionDeps;
    readonly createManifest?: CodexGoalJobManifestInput;
    readonly createOverwrite?: boolean;
    readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
    readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
    readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
    readonly startLaunch?: CodexGoalLaunchInput;
    readonly startSkipDoctor?: boolean;
    readonly stopLaunch?: CodexGoalLaunchInput;
    readonly reviewLaunch?: CodexGoalLaunchInput;
    readonly reviewNote?: string;
};
export declare function createCodexProjectControlBroker(input: CodexProjectControlBrokerInput): ProjectControlBroker;
export declare function projectControlAuditPath(controller: CodexGoalJobManifest): string;
//# sourceMappingURL=codex-goal-mcp-project-broker.d.ts.map