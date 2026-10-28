/** Shared SKILL.md boundary detection. Metadata validation stays with SkillMetadataParser. */
export function splitSkillFrontmatter(rawContent: string) {
  const content = rawContent.replace(/^\uFEFF/, '');
  if (!content.startsWith('---'))
    return { status: 'missing' as const, rawFrontmatter: null, body: content };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  if (!match) return { status: 'invalid' as const, rawFrontmatter: null, body: content };
  return { status: 'present' as const, rawFrontmatter: match[1], body: match[2] ?? '' };
}
