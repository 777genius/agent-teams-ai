export const RENDERER_BOUNDARY_DIAGNOSTIC = 'phase1-hosted-electron-api-forbidden' as const;

export interface RendererBoundarySource {
  readonly path: string;
  readonly source: string;
}

export interface RendererBoundaryDiagnostic {
  readonly path: string;
  readonly diagnostic: typeof RENDERER_BOUNDARY_DIAGNOSTIC;
}

const BROAD_ELECTRON_FACET =
  /(?:extends\s+ElectronAPI|ElectronAPI\s*\[\s*['"]teams['"]\s*\]|\bas\s+ElectronAPI\b|\bteams\s*:\s*ElectronAPI|\b(?:createTeam|launchTeam|stopTeam|killProcess|readFileForToolApproval)\s*\()/;
const HOSTED_RENDERER_BYPASS =
  /(?:window\.electronAPI|new\s+HttpAPIClient|from\s*['"]@renderer\/api['"]|\bapi\.teams\b)/;

/** Scans only caller-supplied hosted facet/renderer sources; no production graph is generated. */
export function checkRendererBoundaries(
  sources: readonly RendererBoundarySource[]
): readonly RendererBoundaryDiagnostic[] {
  return sources.flatMap(({ path, source }) =>
    BROAD_ELECTRON_FACET.test(source) || HOSTED_RENDERER_BYPASS.test(source)
      ? [{ path, diagnostic: RENDERER_BOUNDARY_DIAGNOSTIC }]
      : []
  );
}
