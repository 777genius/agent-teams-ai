export interface InlineChip {
  id: string;
  filePath: string;
  fileName: string;
  fromLine: number | null;
  toLine: number | null;
  codeText: string;
  language: string;
  displayPath?: string;
  isFolder?: boolean;
}
