import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { publishImmutableTextArtifact } from "../local-immutable-text-artifact";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("immutable text artifact publisher", () => {
  it("reuses an identical immutable artifact", async () => {
    const root = await makeTempRoot();
    const path = join(root, "artifact.txt");

    const first = await publish(path, "content\n");
    const second = await publish(path, "content\n");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(path, "utf8")).toBe("content\n");
  });

  it("rejects conflicting content at an immutable artifact path", async () => {
    const root = await makeTempRoot();
    const path = join(root, "artifact.txt");
    await publish(path, "first\n");

    await expect(publish(path, "second\n")).rejects.toThrow(
      "test_artifact_content_mismatch",
    );
    expect(await readFile(path, "utf8")).toBe("first\n");
  });

  it("rejects a symlink without reading or changing its target", async () => {
    const root = await makeTempRoot();
    const targetPath = join(root, "target.txt");
    const artifactPath = join(root, "artifact.txt");
    await writeFile(targetPath, "target\n", "utf8");
    await symlink(targetPath, artifactPath);

    await expect(publish(artifactPath, "replacement\n")).rejects.toThrow(
      "test_artifact_existing_path_unsafe",
    );
    expect(await readFile(targetPath, "utf8")).toBe("target\n");
  });

  it("rejects a symlinked parent directory", async () => {
    const root = await makeTempRoot();
    const targetDirectory = join(root, "target-directory");
    const symlinkDirectory = join(root, "artifact-directory");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, symlinkDirectory);

    await expect(
      publish(join(symlinkDirectory, "artifact.txt"), "content\n"),
    ).rejects.toThrow("test_artifact_existing_path_unsafe");
    await expect(
      readFile(join(targetDirectory, "artifact.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "immutable-text-artifact-test-"));
  tempRoots.push(root);
  return root;
}

async function publish(path: string, content: string) {
  return await publishImmutableTextArtifact({
    path,
    content,
    existingPathUnsafeError: "test_artifact_existing_path_unsafe",
    contentMismatchError: "test_artifact_content_mismatch",
  });
}
