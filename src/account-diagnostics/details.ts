const unsafeDetailKeyPattern =
  /(?:^|_)(?:token|secret|password|auth|oauth|cookie|credential|session|account|email|user|identity|quota)(?:_|$)/i;

export function sanitizeDiagnosticDetails(
  details: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!details) return undefined;
  const safeEntries = Object.entries(details).filter(
    ([key, value]) =>
      !isUnsafeDetailKey(key) && !looksSensitiveValue(value),
  );
  return safeEntries.length ? Object.fromEntries(safeEntries) : undefined;
}

function isUnsafeDetailKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
  return unsafeDetailKeyPattern.test(normalized);
}

function looksSensitiveValue(value: string): boolean {
  return (
    value.includes("@") ||
    /\b(?:token|secret|oauth|bearer|refresh|access)\b/i.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\./.test(value)
  );
}
