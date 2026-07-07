/// <reference types="node" />
import { ProjectAdmissionWorkerRole, ProjectOperation, evaluateProjectAdmission, type ProjectAccessScope, type ProjectAdmissionGate, type ProjectAdmissionSnapshot } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "./codex-goal-jobs.js";
type JsonObject = Readonly<Record<string, unknown>>;
export type CodexProjectAdmissionDeps = {
    readonly listJobs: (input: {
        readonly registryRootDir: string;
    }) => Promise<readonly CodexGoalJobSummary[]>;
    readonly buildOverviewItem: (input: {
        readonly registryRootDir: string;
        readonly jobId: string;
        readonly staleAfterMs: number;
        readonly tailLines: number;
    }) => Promise<JsonObject>;
};
type CodexProjectAdmissionInput = {
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
    readonly deps: CodexProjectAdmissionDeps;
};
export declare function projectAdmissionDetailView(input: {
    readonly snapshot: ProjectAdmissionSnapshot;
    readonly decision?: ReturnType<typeof evaluateProjectAdmission>;
    readonly includeDetails: boolean;
    readonly maxDebtItems?: number;
}): {
    readonly snapshot: JsonObject;
    readonly decision?: JsonObject;
};
export declare function codexProjectAdmissionGate(input: CodexProjectAdmissionInput): ProjectAdmissionGate;
export declare function readCodexProjectAdmissionSnapshot(input: CodexProjectAdmissionInput): Promise<ProjectAdmissionSnapshot>;
export declare function buildCodexProjectAdmissionSnapshot(input: CodexProjectAdmissionInput): Promise<ProjectAdmissionSnapshot>;
export declare function projectAdmissionOperation(value: unknown): ProjectOperation | undefined;
export declare function projectAdmissionWorkerRoleArg(value: unknown): ProjectAdmissionWorkerRole | undefined;
export declare function optionalRealPathForAdmission(path: string): Promise<string | undefined>;
export {};
//# sourceMappingURL=codex-goal-mcp-project-admission.d.ts.map