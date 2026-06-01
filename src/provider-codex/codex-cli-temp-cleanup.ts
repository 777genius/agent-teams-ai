import { rm } from "node:fs/promises";
import { join } from "node:path";

const transientCleanupErrorCodes = new Set([
  "EBUSY",
  "EACCES",
  "ENOTEMPTY",
  "EPERM",
]);

export async function cleanupCodexRuntimeTempRoot(input: {
  readonly tempRoot: string;
  readonly tempCodexHome: string;
}): Promise<void> {
  const secretsScrubbed = await scrubSensitiveCodexHomePaths(
    input.tempCodexHome,
  );

  try {
    await rm(input.tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    if (secretsScrubbed && isTransientCodexTempCleanupError(error)) {
      return;
    }
    throw error;
  }
}

export function isTransientCodexTempCleanupError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string" && transientCleanupErrorCodes.has(code)) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("directory not empty") ||
    message.includes("resource busy") ||
    message.includes("operation not permitted")
  );
}

async function scrubSensitiveCodexHomePaths(
  codexHome: string,
): Promise<boolean> {
  const results = await Promise.allSettled([
    rm(join(codexHome, "auth.json"), { force: true }),
    rm(join(codexHome, "accounts"), { recursive: true, force: true }),
  ]);
  return results.every((result) => result.status === "fulfilled");
}
