/**
 * Formats an agent type string into a human-readable role label.
 *
 * Returns `null` for the default "general-purpose" type so callers can
 * conditionally hide the role entirely.
 */
export function formatAgentRole(agentType: string | undefined): string | null {
  if (!agentType || agentType === 'general-purpose') {
    return null;
  }

  // Capitalise first letter of every word, replace hyphens with spaces.
  return agentType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
