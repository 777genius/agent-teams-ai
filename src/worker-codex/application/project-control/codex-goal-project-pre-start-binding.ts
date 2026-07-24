import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
  CodexGoalProjectPreStartAdmission,
} from "../../codex-goal-jobs";
import { captureGitWorkspacePatch } from "../../codex-goal-runtime-result-io";
import { stagedPatchSha256 } from "./codex-goal-project-git";

const execFileAsync = promisify(execFile);
const VALIDATOR_TIMEOUT_MS = 60_000;
const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectPreStartBinding = {
  readonly workspaceHead: string;
  readonly workspaceStatus: string;
  readonly workspaceStagedPatchSha256: string;
  readonly workspaceStagedPaths: readonly string[];
  readonly workspaceUnstagedDirty: boolean;
  readonly workspacePatchSha256: string;
  readonly contractSha256: string;
  readonly stateSha256: string;
  readonly promptSha256: string;
};

export type VerifiedInputPatchBinding = {
  readonly artifactSha256: string;
  readonly stagedPatchSha256: string;
};

export async function captureProjectPreStartBinding(
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
  descriptor: CodexGoalProjectPreStartAdmission,
): Promise<ProjectPreStartBinding> {
  const workspaceHead = (
    await execFileAsync(
      "git",
      ["-C", manifest.workspacePath, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
        timeout: VALIDATOR_TIMEOUT_MS,
      },
    )
  ).stdout.trim();
  const workspaceStatus = (
    await execFileAsync(
      "git",
      [
        "-C",
        manifest.workspacePath,
        "status",
        "--porcelain",
        "--untracked-files=all",
      ],
      { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
    )
  ).stdout.trim();
  const workspaceStagedPatchSha256 = await stagedPatchSha256(
    manifest.workspacePath,
  );
  const workspaceStagedPaths = parseNullDelimitedPaths(
    (
      await execFileAsync(
        "git",
        [
          "-C",
          manifest.workspacePath,
          "diff",
          "--cached",
          "--name-only",
          "-z",
          "--",
        ],
        { encoding: "buffer", timeout: VALIDATOR_TIMEOUT_MS },
      )
    ).stdout,
  );
  const workspaceUnstagedPaths = (
    await execFileAsync(
      "git",
      ["-C", manifest.workspacePath, "diff", "--name-only", "-z", "--"],
      { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
    )
  ).stdout;
  const workspaceUntrackedPaths = (
    await execFileAsync(
      "git",
      [
        "-C",
        manifest.workspacePath,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
    )
  ).stdout;
  const workspacePatchSha256 = sha256(
    Buffer.from(
      await captureGitWorkspacePatch({ workspacePath: manifest.workspacePath }),
    ),
  );
  return {
    workspaceHead,
    workspaceStatus,
    workspaceStagedPatchSha256,
    workspaceStagedPaths,
    workspaceUnstagedDirty:
      workspaceUnstagedPaths.length > 0 || workspaceUntrackedPaths.length > 0,
    workspacePatchSha256,
    contractSha256: sha256(
      Buffer.from(
        await readBoundedFile(
          descriptor.contractPath,
          MAX_CONTRACT_BYTES,
          "contract",
        ),
      ),
    ),
    stateSha256: sha256(
      Buffer.from(
        await readBoundedFile(descriptor.statePath, MAX_STATE_BYTES, "state"),
      ),
    ),
    promptSha256: sha256(
      Buffer.from(
        await readBoundedFile(manifest.promptPath, MAX_PROMPT_BYTES, "prompt"),
      ),
    ),
  };
}

function parseNullDelimitedPaths(value: Buffer): readonly string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function verifiedInputPatchBindingValid(
  binding: ProjectPreStartBinding,
  verifiedInputPatch: VerifiedInputPatchBinding,
): boolean {
  return (
    /^[0-9a-f]{64}$/.test(verifiedInputPatch.artifactSha256) &&
    /^[0-9a-f]{64}$/.test(verifiedInputPatch.stagedPatchSha256) &&
    binding.workspaceStatus !== "" &&
    !binding.workspaceUnstagedDirty &&
    binding.workspaceStagedPatchSha256 === verifiedInputPatch.stagedPatchSha256
  );
}

export async function readVerifiedInputPatchFromExistingReceipt(
  descriptor: CodexGoalProjectPreStartAdmission,
  contract: JsonObject,
): Promise<VerifiedInputPatchBinding | undefined> {
  let receipt: JsonObject;
  try {
    receipt = await readJsonObject(
      descriptor.receiptPath,
      "receipt",
      64 * 1024,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (
      error instanceof Error &&
      error.message === "project_control_pre_start_receipt_invalid"
    ) {
      try {
        await access(descriptor.receiptPath);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
      }
    }
    throw error;
  }
  return verifiedInputPatchFromReceipt(receipt, contract);
}

export function verifiedInputPatchFromReceipt(
  receipt: JsonObject,
  contract: JsonObject,
): VerifiedInputPatchBinding | undefined {
  if (receipt.workspaceMode !== "verified_input_patch") return undefined;
  const artifactSha256 = requiredSha256(
    receipt.inputPatchArtifactSha256,
    "inputPatchArtifactSha256",
  );
  const stagedPatchSha256 = requiredSha256(
    receipt.workspaceStagedPatchSha256,
    "workspaceStagedPatchSha256",
  );
  if (receipt.expectedWorkspaceStagedPatchSha256 === undefined) {
    throw new Error(
      "project_control_pre_start_verified_input_patch_receipt_migration_required",
    );
  }
  const expectedStagedPatchSha256 = requiredSha256(
    receipt.expectedWorkspaceStagedPatchSha256,
    "expectedWorkspaceStagedPatchSha256",
  );
  if (
    artifactSha256 !== requiredSha256(contract.inputPatchHash, "inputPatchHash")
  ) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  if (stagedPatchSha256 !== expectedStagedPatchSha256) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  return { artifactSha256, stagedPatchSha256: expectedStagedPatchSha256 };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJsonObject(
  path: string,
  label: string,
  maxBytes: number,
): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(
      await readBoundedFile(path, maxBytes, label),
    );
    if (!isObject(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new Error(`project_control_pre_start_${label}_invalid`);
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`project_control_pre_start_${label}_size_limit_exceeded`);
  }
  return bytes.toString("utf8");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`project_control_pre_start_${field}_required`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  const parsed = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`project_control_pre_start_${field}_invalid`);
  }
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
