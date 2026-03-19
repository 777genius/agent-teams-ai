/**
 * Shared utility for converting @memberName and @teamName mentions in plain text
 * to markdown links with mention:// and team:// protocols.
 *
 * Used by UserChatGroup, TeammateMessageItem, ActivityItem, TaskCommentsSection.
 * MarkdownViewer already handles rendering mention:// and team:// links as colored badges.
 */

/**
 * Convert `@memberName` in plain text to markdown links with mention:// protocol.
 * Encodes color in the URL so MarkdownViewer can render colored badges without extra context.
 * Greedy match: longer names are tried first to avoid partial matches.
 *
 * @param text - The plain text to process
 * @param memberColorMap - Map of member name → color key (e.g. "blue", "red")
 * @returns Text with @mentions replaced by markdown links
 */
export function linkifyMentionsInMarkdown(
  text: string,
  memberColorMap: Map<string, string>
): string {
  if (memberColorMap.size === 0) return text;

  // Sort by name length descending for greedy matching
  const names = [...memberColorMap.keys()].sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    // eslint-disable-next-line no-useless-escape -- backslash-quote and backslash-hyphen needed in template literal for RegExp
    `(^|[\\s(\\[{"\'])@(${escaped.join('|')})(?=[\\s,.:;!?)\\]}\-]|$)`,
    'gi'
  );

  return text.replace(pattern, (_match: string, prefix: string, name: string) => {
    // Find the canonical name (case-insensitive lookup)
    const canonical = names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    const color = memberColorMap.get(canonical) ?? '';
    return `${prefix}[@${canonical}](mention://${encodeURIComponent(color)}/${encodeURIComponent(canonical)})`;
  });
}

/**
 * Convert `@teamName` in plain text to markdown links with team:// protocol.
 * Greedy match: longer names are tried first to avoid partial matches.
 *
 * @param text - The plain text to process
 * @param teamNames - Set or array of known team names
 * @returns Text with @teamName replaced by markdown links
 */
export function linkifyTeamMentionsInMarkdown(
  text: string,
  teamNames: ReadonlySet<string> | readonly string[]
): string {
  const names: readonly string[] = Array.isArray(teamNames) ? teamNames : [...teamNames];
  if (names.length === 0) return text;

  // Sort by name length descending for greedy matching
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    // eslint-disable-next-line no-useless-escape -- backslash-quote and backslash-hyphen needed in template literal for RegExp
    `(^|[\\s(\\[{"\'])@(${escaped.join('|')})(?=[\\s,.:;!?)\\]}\-]|$)`,
    'gi'
  );

  return text.replace(pattern, (_match: string, prefix: string, name: string) => {
    const canonical = sorted.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    return `${prefix}[${canonical}](team://${encodeURIComponent(canonical)})`;
  });
}

/**
 * Apply both member and team linkification. Team names are matched first to avoid
 * team names being captured as member mentions when they share similar names.
 *
 * @param text - The plain text to process
 * @param memberColorMap - Map of member name → color key
 * @param teamNames - Known team names
 * @returns Text with both @member and @team mentions replaced by markdown links
 */
export function linkifyAllMentionsInMarkdown(
  text: string,
  memberColorMap: Map<string, string>,
  teamNames: ReadonlySet<string> | readonly string[] = []
): string {
  // Apply team linkification first (team names tend to be longer / more specific)
  let result = linkifyTeamMentionsInMarkdown(text, teamNames);
  // Then member linkification on the remaining text
  result = linkifyMentionsInMarkdown(result, memberColorMap);
  return result;
}
