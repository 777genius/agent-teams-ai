const LEAD_MEMBER_NAMES = new Set(['team-lead']);

export function isTeammateTaskCommentAuthor(author: string): boolean {
  const normalized = author.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'user' && !LEAD_MEMBER_NAMES.has(normalized);
}
