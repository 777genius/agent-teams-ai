const OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE = new Set(['cursor-acp']);

export function shouldShowOpenCodeNeedsTestBadge(
  proofState: string | null | undefined,
  sourceId: string | null | undefined
): boolean {
  return (
    proofState === 'needs_probe' &&
    !OPENCODE_SOURCES_WITHOUT_NEEDS_TEST_BADGE.has(sourceId?.trim().toLowerCase() ?? '')
  );
}
