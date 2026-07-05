import type { RuntimeProjectionDiagnosticEvidence } from './RuntimeProjectionEvidence';
import type { TeamAgentRuntimeDiagnosticSeverity } from '@shared/types';

export interface RuntimeProjectionDiagnosticProjection {
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [
    /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    '$1[redacted]',
  ],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]'],
  [/\bauthorization:\s*bearer\s+[^'"\s]+/gi, 'authorization: bearer [redacted]'],
  [
    /\b([A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[=:]\s*)['"]?[^'"\s]+/gi,
    '$1[redacted]',
  ],
];

function sanitizeRuntimeDiagnosticMessage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let sanitized = trimmed;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.slice(0, 500);
}

function normalizeDiagnostics(values: readonly (string | undefined)[]): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const sanitized = sanitizeRuntimeDiagnosticMessage(value);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    diagnostics.push(sanitized);
    seen.add(sanitized);
  }
  return diagnostics;
}

export function projectRuntimeDiagnostics(
  evidence: RuntimeProjectionDiagnosticEvidence | undefined,
  fallback?: RuntimeProjectionDiagnosticEvidence
): RuntimeProjectionDiagnosticProjection {
  const runtimeDiagnostic =
    sanitizeRuntimeDiagnosticMessage(evidence?.message) ??
    sanitizeRuntimeDiagnosticMessage(fallback?.message);
  const diagnostics = normalizeDiagnostics([
    runtimeDiagnostic,
    ...(evidence?.diagnostics ?? []),
    ...(fallback?.diagnostics ?? []),
  ]);
  return {
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(runtimeDiagnostic || diagnostics.length > 0
      ? { runtimeDiagnosticSeverity: evidence?.severity ?? fallback?.severity ?? 'info' }
      : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
