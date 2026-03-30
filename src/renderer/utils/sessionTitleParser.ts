/**
 * Parses session `firstMessage` into a structured title for sidebar display.
 *
 * Source formats (generated in src/main/services/team/TeamProvisioningService.ts):
 *   New team  (line ~944): agent_teams_ui [Agent Team: "name" | Project: "proj" | Lead: "lead"] ...
 *   Resume    (line ~1046): Team Start [Agent Team: "name" | Project: "proj" | Lead: "lead"] ...
 *              (line ~1044): Team Start (resume) [Agent Team: ...] ...
 */

export interface ParsedSessionTitle {
  kind: 'team-new' | 'team-resume' | 'regular';
  /** Cleaned display text — team name for team sessions, cleaned prompt for regular */
  displayText: string;
  teamName?: string;
  projectName?: string;
}

// Matches: agent_teams_ui [Agent Team: "name" | Project: "proj" | Lead: "lead"]
// Handles both straight quotes ("") and smart quotes (\u201C\u201D)
const PROVISION_RE =
  /^agent_teams_ui\s+\[Agent Team:\s*["\u201C]([^"\u201D]+)["\u201D]\s*\|\s*Project:\s*["\u201C]([^"\u201D]+)["\u201D]\s*\|\s*Lead:\s*["\u201C]([^"\u201D]+)["\u201D]\]/;

// Matches: Team Start [Agent Team: ...] (after stripping optional "(resume)" prefix)
const LAUNCH_RE =
  /^Team Start\s+\[Agent Team:\s*["\u201C]([^"\u201D]+)["\u201D]\s*\|\s*Project:\s*["\u201C]([^"\u201D]+)["\u201D]\s*\|\s*Lead:\s*["\u201C]([^"\u201D]+)["\u201D]\]/;

// Matches one or more [Image #N] prefixes
const IMAGE_PREFIX_RE = /^(?:\[Image\s+#\d+\]\s*)+/;

export function parseSessionTitle(firstMessage: string | undefined): ParsedSessionTitle {
  if (!firstMessage) {
    return { kind: 'regular', displayText: 'Untitled' };
  }

  // New team provisioning: agent_teams_ui [Agent Team: ...]
  const provisionMatch = PROVISION_RE.exec(firstMessage);
  if (provisionMatch) {
    return {
      kind: 'team-new',
      displayText: provisionMatch[1],
      teamName: provisionMatch[1],
      projectName: provisionMatch[2],
    };
  }

  // Team resume/launch: Team Start [Agent Team: ...] or Team Start (resume) [...]
  const launchMsg = firstMessage.replace(/^(Team Start)\s*\(resume\)/, '$1');
  const launchMatch = LAUNCH_RE.exec(launchMsg);
  if (launchMatch) {
    return {
      kind: 'team-resume',
      displayText: launchMatch[1],
      teamName: launchMatch[1],
      projectName: launchMatch[2],
    };
  }

  // Regular session — strip [Image #N] prefixes
  const cleaned = firstMessage.replace(IMAGE_PREFIX_RE, '').trim();
  return {
    kind: 'regular',
    displayText: cleaned || 'Untitled',
  };
}

/** Convenience: returns just the display label string. */
export function formatSessionLabel(firstMessage: string | undefined): string {
  return parseSessionTitle(firstMessage).displayText;
}
