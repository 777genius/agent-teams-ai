import { UserError } from 'fastmcp';

/** Preserve app refusal codes and uncertain outcomes through the MCP tool error boundary. */
export function asClientRefusal(error: unknown): unknown {
  const refusal = error as { appRefusal?: unknown; code?: unknown; outcome?: unknown } | null;
  if (!(error instanceof Error) || refusal?.appRefusal !== true || typeof refusal.code !== 'string')
    return error;
  const { code, outcome } = refusal;
  const details = { code, ...(outcome && typeof outcome === 'object' ? { outcome } : {}) };
  return Object.assign(new UserError(`[${code}] ${error.message}`, details), details);
}
