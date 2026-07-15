export type SecretLikeContentKind =
  | "private_key"
  | "openai_token"
  | "github_token"
  | "aws_access_key"
  | "slack_token"
  | "bearer_token"
  | "jwt_token"
  | "quoted_secret_assignment"
  | "unquoted_secret_assignment"
  | "env_secret_assignment"
  | "opaque_content";

export enum OpaqueSecretDetectionPolicy {
  Reject = "reject",
  ScanKnownSignatures = "scan_known_signatures",
}

export type SecretDetectionContext = {
  readonly filePath?: string;
  readonly opaqueContentPolicy?: OpaqueSecretDetectionPolicy;
};

type SecretLikeContentPolicy = {
  readonly kind: SecretLikeContentKind;
  readonly pattern: RegExp;
};

type GenericAssignmentPolicy = SecretLikeContentPolicy & {
  readonly literalCaptureIndex: number;
};

const explicitFixtureLiterals = new Set([
  "test-fixture-literal",
  "fixture-fixture-literal",
  "example-fixture-literal",
  "placeholder-fixture-literal",
]);

const explicitFixtureDirectoryNames = new Set([
  "test",
  "tests",
  "__tests__",
  "fixture",
  "fixtures",
  "__fixtures__",
]);

const authoritativeSecretPolicies: readonly SecretLikeContentPolicy[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    kind: "openai_token",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    kind: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    kind: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    kind: "env_secret_assignment",
    pattern: /(?:^|\n)\s*[+-]?\s*SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY\s*=\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  },
  {
    kind: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}(?![A-Za-z0-9._~+/-])/i,
  },
];

const compactJwtCandidatePattern =
  /(?<![A-Za-z0-9_.])(e[wy][A-Za-z0-9_-]+\.e[wy][A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)(?![A-Za-z0-9_.-])/g;

const genericAssignmentPolicies: readonly GenericAssignmentPolicy[] = [
  {
    kind: "quoted_secret_assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret)\b\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']/gi,
    literalCaptureIndex: 1,
  },
  {
    kind: "env_secret_assignment",
    pattern: /(?:^|\n)\s*[+-]?\s*[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|CLIENT_SECRET|SECRET)\s*=\s*([A-Za-z0-9_./+=-]{16,})\s*(?=\r?$|\n)/gi,
    literalCaptureIndex: 1,
  },
  {
    kind: "unquoted_secret_assignment",
    pattern: /(?:^|\n)\s*[+-]?\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret)\s*[:=]\s*(?!process\.env\.)([A-Za-z0-9_./+=-]{16,})\s*(?=\r?$|\n)/gi,
    literalCaptureIndex: 1,
  },
];

export function detectSecretLikeContent(
  value: string | Buffer,
  context: SecretDetectionContext = {},
): SecretLikeContentKind | undefined {
  const text = typeof value === "string" ? value : value.toString("utf8");
  const authoritativeMatch = authoritativeSecretPolicies.find((policy) =>
    matchesPolicy(text, policy)
  );
  if (authoritativeMatch) return authoritativeMatch.kind;
  if (containsCompactJwt(text)) return "jwt_token";
  const genericMatch = genericAssignmentPolicies.find((policy) =>
    containsUnsafeGenericAssignment(text, policy, context)
  );
  if (genericMatch) return genericMatch.kind;
  if (
    Buffer.isBuffer(value) &&
    isOpaqueContent(value, text) &&
    context.opaqueContentPolicy !==
      OpaqueSecretDetectionPolicy.ScanKnownSignatures
  ) {
    return "opaque_content";
  }
  return undefined;
}

export function matchesSecretLikeContentPatterns(
  value: string | Buffer,
  patterns: readonly RegExp[],
): boolean {
  const text = typeof value === "string" ? value : value.toString("utf8");
  return patterns.some((pattern) => matchesPattern(text, pattern));
}

function containsUnsafeGenericAssignment(
  text: string,
  policy: GenericAssignmentPolicy,
  context: SecretDetectionContext,
): boolean {
  policy.pattern.lastIndex = 0;
  try {
    for (
      let match = policy.pattern.exec(text);
      match !== null;
      match = policy.pattern.exec(text)
    ) {
      const literal = match[policy.literalCaptureIndex];
      if (
        literal === undefined ||
        !isAllowedFixtureLiteral(literal, context.filePath)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    policy.pattern.lastIndex = 0;
  }
}

function isAllowedFixtureLiteral(
  literal: string,
  filePath: string | undefined,
): boolean {
  return explicitFixtureLiterals.has(literal) &&
    isExplicitFixtureContext(filePath);
}

function isExplicitFixtureContext(filePath: string | undefined): boolean {
  if (filePath === undefined || filePath.length === 0) return false;
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => explicitFixtureDirectoryNames.has(part))) return true;
  const fileName = parts.at(-1) ?? "";
  return /(?:^|[._-])(?:test|spec|fixture)(?:[._-]|$)/.test(fileName);
}

function matchesPolicy(text: string, policy: SecretLikeContentPolicy): boolean {
  return matchesPattern(text, policy.pattern);
}

function matchesPattern(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  try {
    return pattern.test(text);
  } finally {
    pattern.lastIndex = 0;
  }
}

function containsCompactJwt(text: string): boolean {
  compactJwtCandidatePattern.lastIndex = 0;
  try {
    for (
      let match = compactJwtCandidatePattern.exec(text);
      match !== null;
      match = compactJwtCandidatePattern.exec(text)
    ) {
      const [header, payload] = (match[1] ?? "").split(".");
      const decodedHeader = decodeCompactJwtJsonObject(header);
      const decodedPayload = decodeCompactJwtJsonObject(payload);
      if (
        decodedHeader !== undefined &&
        decodedPayload !== undefined &&
        typeof decodedHeader.alg === "string" &&
        decodedHeader.alg.length > 0
      ) {
        return true;
      }
    }
    return false;
  } finally {
    compactJwtCandidatePattern.lastIndex = 0;
  }
}

function decodeCompactJwtJsonObject(
  segment: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (segment === undefined) return undefined;
  try {
    const bytes = Buffer.from(segment, "base64url");
    if (bytes.toString("base64url") !== segment) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

function isOpaqueContent(value: Buffer, decoded: string): boolean {
  if (!Buffer.from(decoded, "utf8").equals(value)) return true;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded);
}
