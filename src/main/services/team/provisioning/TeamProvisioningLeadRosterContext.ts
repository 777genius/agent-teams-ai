export function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: { name: string; role?: string }[]
): string | null {
  if (teammates.length === 0) return null;

  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');

  return [
    `Current durable team context:`,
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    `- This team is NOT in solo mode`,
    `- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.`,
  ].join('\n');
}
