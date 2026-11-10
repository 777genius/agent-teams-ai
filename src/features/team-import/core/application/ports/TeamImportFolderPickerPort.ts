export interface TeamImportFolderPickerPort {
  chooseFolder(): Promise<string | null>;
}
