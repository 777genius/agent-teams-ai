export interface SaveEditedFileInput {
  filePath: string;
  content: string;
  expectedCurrentContent: string | null;
}

export interface DeleteEditedFileInput {
  filePath: string;
  expectedCurrentContent: string;
}

export function parseSaveEditedFileInput(
  filePath: unknown,
  content: unknown,
  expectedCurrentContent: unknown
): SaveEditedFileInput | null {
  if (
    typeof filePath !== 'string' ||
    typeof content !== 'string' ||
    (expectedCurrentContent !== null && typeof expectedCurrentContent !== 'string')
  ) {
    return null;
  }
  return { filePath, content, expectedCurrentContent };
}

export function parseDeleteEditedFileInput(
  filePath: unknown,
  expectedCurrentContent: unknown
): DeleteEditedFileInput | null {
  return typeof filePath === 'string' && typeof expectedCurrentContent === 'string'
    ? { filePath, expectedCurrentContent }
    : null;
}
