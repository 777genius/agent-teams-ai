/** Expensive OpenCode model verification is for selected OpenCode members only. */
export function shouldLoadOpenCodeDialogCatalog(
  open: boolean,
  launching: boolean,
  multimodelEnabled: boolean,
  selectedProviders: readonly string[]
): boolean {
  return open && launching && multimodelEnabled && selectedProviders.includes('opencode');
}
