export function toSuggestedSkillFolderName(value: string, fallback = 'new-skill'): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return normalized || fallback;
}

export function getSuggestedSkillFolderNameFromPath(
  value: string,
  fallback = 'imported-skill'
): string {
  const segments = value.split(/[\\/]/u).filter(Boolean);
  return toSuggestedSkillFolderName(segments.at(-1) ?? '', fallback);
}
