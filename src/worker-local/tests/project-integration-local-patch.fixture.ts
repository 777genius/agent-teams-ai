import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { gitOutput } from "./project-integration-local-adapters.fixture";

interface WorkerCommitFixture {
  readonly workspacePath: string;
  readonly workerCommitSha: string;
}

export async function writeWorkerCommitPatch(
  fixture: WorkerCommitFixture,
  patchPath: string,
): Promise<{
  readonly patch: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}> {
  const patch = await gitOutput(fixture.workspacePath, [
    "show",
    "--format=",
    fixture.workerCommitSha,
  ]);
  await writeFile(patchPath, patch);
  return {
    patch,
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  };
}
