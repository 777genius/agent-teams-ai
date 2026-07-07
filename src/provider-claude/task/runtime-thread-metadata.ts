import type { ProviderTask } from "@vioxen/subscription-runtime/core";
import type { ClaudeRuntimeThreadInput } from "./engine-contract";

export const claudeRuntimeThreadIdMetadataKey = "claudeRuntimeThreadId";
export const claudeRuntimeResumeSessionIdMetadataKey =
  "claudeRuntimeResumeSessionId";

export function runtimeThreadFromMetadata(
  metadata: ProviderTask["metadata"],
): ClaudeRuntimeThreadInput | undefined {
  const threadId = metadata?.[claudeRuntimeThreadIdMetadataKey]?.trim();
  if (!threadId) return undefined;
  const resumeSessionId =
    metadata?.[claudeRuntimeResumeSessionIdMetadataKey]?.trim();
  return {
    threadId,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}
