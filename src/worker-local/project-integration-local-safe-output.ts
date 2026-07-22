export function safeProjectIntegrationOutputTail(
  value: string,
  maxLength = 4000,
): string {
  const redacted = value
    .replaceAll(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replaceAll(/ghp_[A-Za-z0-9_]{12,}/g, "ghp_<redacted>")
    .replaceAll(/github_pat_[A-Za-z0-9_]{12,}/g, "github_pat_<redacted>")
    .replaceAll(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "xox<redacted>")
    .replaceAll(
      /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=<redacted>",
    );
  return redacted.length <= maxLength
    ? redacted
    : redacted.slice(redacted.length - maxLength);
}
