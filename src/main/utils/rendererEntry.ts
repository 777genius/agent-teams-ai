import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RendererLoadDiagnostics {
  packaged: number;
  selected_candidate: number;
  primary_present_at_selection: number;
  fallback_present_at_selection: number;
  primary_present: number;
  fallback_present: number;
  error_code?: number;
}

export interface RendererEntry {
  filePath: string;
  diagnostics(packaged: boolean, error?: unknown): RendererLoadDiagnostics;
}

function getLoadErrorCode(error: unknown): number | undefined {
  // Electron loadFile rejects with an Error carrying a numeric errno. Never
  // parse its message, URL, symbolic code or other arbitrary properties.
  let code = error;
  if (typeof error === 'object' && error !== null) {
    code = Object.getOwnPropertyDescriptor(error, 'errno')?.value;
  }
  return typeof code === 'number' && Number.isInteger(code) && code < 0 && code >= -10_000
    ? code
    : undefined;
}

/** Keep selection and failure-time probes tied to the exact entry passed to loadFile. */
export function resolveRendererEntry(mainDirectory: string): RendererEntry {
  const candidates = [
    join(mainDirectory, '../../out/renderer/index.html'),
    join(mainDirectory, '../renderer/index.html'),
  ] as const;
  const initialPresence = candidates.map((candidate) => Number(existsSync(candidate)));
  // Preserve the existing primary fallback when neither candidate exists.
  const selected = initialPresence[0] || !initialPresence[1] ? 0 : 1;
  return {
    filePath: candidates[selected],
    diagnostics(packaged, error) {
      const code = getLoadErrorCode(error);
      return {
        packaged: Number(packaged),
        selected_candidate: selected,
        primary_present_at_selection: initialPresence[0],
        fallback_present_at_selection: initialPresence[1],
        primary_present: Number(existsSync(candidates[0])),
        fallback_present: Number(existsSync(candidates[1])),
        ...(code !== undefined ? { error_code: code } : {}),
      };
    },
  };
}
