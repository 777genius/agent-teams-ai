const MAX_SKILL_FOLDER_NAME_LENGTH = 255;
const INVALID_SKILL_FOLDER_NAME_CHARS = /[\x00-\x1f/\\:*?"<>|]/u;

export function validateSkillImportSourceDir(value: string): string | null {
  if (value.trim().length === 0) {
    return 'Choose a skill folder to import.';
  }

  return null;
}

export function validateSkillFolderName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Choose a folder name for this skill.';
  }

  if (trimmed.length > MAX_SKILL_FOLDER_NAME_LENGTH) {
    return `Folder name must be ${MAX_SKILL_FOLDER_NAME_LENGTH} characters or fewer.`;
  }

  if (trimmed === '.' || trimmed === '..') {
    return 'Pick a simpler folder name using letters, numbers, dots, dashes, or underscores.';
  }

  if (INVALID_SKILL_FOLDER_NAME_CHARS.test(trimmed)) {
    return 'Pick a simpler folder name using letters, numbers, dots, dashes, or underscores.';
  }

  return null;
}
