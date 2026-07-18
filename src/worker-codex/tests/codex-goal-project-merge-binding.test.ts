import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import {
  bindProjectMergeAdmission,
  parseProjectMergeBindingRequest,
  projectMergePromptBinding,
  readExistingProjectMergeBinding,
  resolveProjectMergeBinding,
} from "../application/project-control/codex-goal-project-merge-binding";
import { parseWorkerLaunchSpec } from "../application/project-control/worker-launch-spec";
import {
  readAdmittedMergeBinding,
  selectReviewedOutputMerge,
} from "../codex-goal-mcp-project-control-review";
import {
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project merge binding", () => {
  it("pins target and source without mutating FETCH_HEAD and produces a strict final contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-merge-binding-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    await mkdir(remote, { recursive: true });
    await git(remote, ["init", "--bare"]);
    await mkdir(workspace, { recursive: true });
    await gitInitRepository(workspace);
    await git(workspace, ["remote", "add", "origin", remote]);
    await writeFile(join(workspace, "value.txt"), "target\n");
    await git(workspace, ["add", "."]);
    await git(workspace, ["commit", "-m", "test: target"]);
    const targetCommit = (
      await gitStdout(workspace, ["rev-parse", "HEAD"])
    ).trim();
    await git(workspace, ["branch", "-M", "main"]);
    await git(workspace, ["push", "origin", "main"]);
    await git(workspace, ["switch", "-c", "base/current"]);
    await writeFile(join(workspace, "base.txt"), "source\n");
    await git(workspace, ["add", "."]);
    await git(workspace, ["commit", "-m", "test: source"]);
    const sourceCommit = (
      await gitStdout(workspace, ["rev-parse", "HEAD"])
    ).trim();
    await git(workspace, ["push", "origin", "base/current"]);
    await git(workspace, ["switch", "main"]);
    await rm(join(workspace, ".git", "FETCH_HEAD"), { force: true });

    const scope = {
      projectId: "test",
      workspaceRoots: [workspace],
      worktreeRoots: [join(root, "worktrees")],
      registryRoot: join(root, "registry"),
      authRoot: join(root, "auth"),
      jobIdPrefixes: ["test-"],
      tmuxSessionPrefixes: ["test-"],
      allowedBranches: ["main", "base/*"],
      allowedGitRemotes: ["origin"],
    } satisfies ProjectAccessScope;
    const merge = await resolveProjectMergeBinding({
      workspacePath: workspace,
      scope,
      targetRemoteTrackingRef: "origin/main",
      binding: { sourceRemote: "origin", sourceBranch: "base/current" },
    });
    expect(merge).toEqual({
      sourceRemote: "origin",
      sourceBranch: "base/current",
      sourceCommit,
      expectedTargetCommit: targetCommit,
    });
    await expect(
      access(join(workspace, ".git", "FETCH_HEAD")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const admission = bindProjectMergeAdmission({
      admission: {
        mode: "serial-builtin",
        contract: contractWithoutPhaseStart(root, workspace),
      },
      merge,
    }) as { readonly contract: Record<string, unknown> };
    expect(admission.contract).toMatchObject({
      canonicalSha: targetCommit,
      phaseStartSha: targetCommit,
      merge,
    });
    expect(() =>
      parseWorkerLaunchSpec({
        ...admission.contract,
        jobId: "test-worker",
        workerId: "test-worker",
        revision: 0,
        retryCount: 0,
        workKey: "a".repeat(64),
        supersedes: null,
        registryStatus: "queued",
        jobRoot: join(root, "job"),
        workspaceRoot: workspace,
        promptPath: join(root, "job", "prompt.md"),
      }),
    ).not.toThrowError(/missing_field_phaseStartSha/);
    expect(projectMergePromptBinding(merge)).toContain(sourceCommit);
  });

  it("reuses the immutable stored binding and rejects caller overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-merge-retry-"));
    roots.push(root);
    const merge = {
      sourceRemote: "origin",
      sourceBranch: "base/current",
      sourceCommit: "2".repeat(40),
      expectedTargetCommit: "3".repeat(40),
    };
    const admissionRoot = join(root, "pre-start-admission");
    await mkdir(admissionRoot, { recursive: true });
    await writeFile(
      join(admissionRoot, "contract.json"),
      JSON.stringify({ merge }),
    );
    await expect(readExistingProjectMergeBinding(root)).resolves.toEqual(merge);
    expect(selectReviewedOutputMerge(merge, undefined)).toEqual(merge);
    expect(() =>
      selectReviewedOutputMerge(merge, {
        ...merge,
        sourceCommit: "4".repeat(40),
      }),
    ).toThrow("project_control_review_merge_binding_mismatch");
    const contractBody = Buffer.from(JSON.stringify({ merge }));
    await writeFile(join(admissionRoot, "contract.json"), contractBody);
    await writeFile(
      join(admissionRoot, "receipt.json"),
      JSON.stringify({
        merge,
        contractSha256: createHash("sha256").update(contractBody).digest("hex"),
      }),
    );
    await expect(
      readAdmittedMergeBinding(
        {
          projectPreStartAdmission: {
            schemaVersion: 1,
            mode: "serial-builtin",
            contractPath: join(admissionRoot, "contract.json"),
            statePath: join(admissionRoot, "state.json"),
            receiptPath: join(admissionRoot, "receipt.json"),
          },
        } as never,
        {
          projectId: "test",
          workspaceRoots: [root],
          worktreeRoots: [root],
          registryRoot: root,
          authRoot: root,
          jobIdPrefixes: ["test-"],
          tmuxSessionPrefixes: ["test-"],
          allowedBranches: ["base/*"],
          allowedGitRemotes: ["origin"],
        },
      ),
    ).resolves.toEqual(merge);
    expect(() =>
      bindProjectMergeAdmission({
        admission: {
          mode: "serial-builtin",
          contract: {
            ...contractWithoutPhaseStart(root, root),
            phaseStartSha: "4".repeat(40),
          },
        },
        merge,
      }),
    ).toThrow("project_control_merge_binding_phaseStartSha_must_be_omitted");
    expect(() =>
      bindProjectMergeAdmission({
        admission: {
          mode: "serial-builtin",
          contract: {
            ...contractWithoutPhaseStart(root, root),
            canonicalSha: "4".repeat(40),
          },
        },
        merge,
      }),
    ).toThrow("project_control_merge_binding_canonicalSha_must_be_omitted");
    expect(() =>
      bindProjectMergeAdmission({
        admission: {
          mode: "serial-builtin",
          contract: {
            ...contractWithoutPhaseStart(root, root),
            merge,
          },
        },
        merge,
      }),
    ).toThrow("project_control_merge_binding_merge_override_denied");
  });

  it("rejects caller-owned merge revisions and expected source commits", () => {
    const mergeBinding = {
      sourceRemote: "origin",
      sourceBranch: "base/current",
    };
    expect(
      parseProjectMergeBindingRequest({
        value: mergeBinding,
        admission: { mode: "serial-builtin", contract: {} },
        requireCanonicalRemoteHead: true,
        expectedSourceCommit: undefined,
      }),
    ).toEqual(mergeBinding);
    expect(() =>
      parseProjectMergeBindingRequest({
        value: mergeBinding,
        admission: { mode: "serial-builtin", contract: {} },
        requireCanonicalRemoteHead: true,
        expectedSourceCommit: "4".repeat(40),
      }),
    ).toThrow("project_control_merge_binding_expected_source_conflict");
    expect(() =>
      parseProjectMergeBindingRequest({
        value: undefined,
        admission: { mode: "serial-builtin", contract: { merge: {} } },
        requireCanonicalRemoteHead: true,
        expectedSourceCommit: undefined,
      }),
    ).toThrow("project_control_merge_binding_runtime_owned");
  });
});

function contractWithoutPhaseStart(root: string, workspace: string) {
  return {
    kind: "worker-launch",
    format: 1,
    baseSha: "1".repeat(40),
    packetRevision: "phase-01-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    phaseId: "phase-01",
    laneId: "merge",
    inputPatchHash: null,
    reviewKind: "implementation",
    ownedPaths: ["src/example.ts"],
    mandatoryDocs: ["controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{ id: "focused", cwd: "src", command: "true" }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(workspace, "sandbox"),
      forbiddenRealProjects: [join(root, "real")],
    },
  };
}
