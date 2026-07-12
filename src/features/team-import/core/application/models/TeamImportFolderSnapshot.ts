export interface TeamImportSourceFile {
  fileName: string;
  content: string;
}

export interface TeamImportSkillDefinition {
  directoryName: string;
  content: string;
}

export interface TeamImportFolderSnapshot {
  projectPath: string;
  folderName: string;
  agentFiles: TeamImportSourceFile[];
  claudeMd?: string;
  skills: TeamImportSkillDefinition[];
  warnings: string[];
}
