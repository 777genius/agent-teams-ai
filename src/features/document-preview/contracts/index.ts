export const DOCUMENT_PREVIEW_READ = 'documentPreview:read';

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export interface DocumentPreviewResult {
  bytes: Uint8Array;
  fileName: string;
  format: DocumentFormat;
}

export interface DocumentPreviewAPI {
  readDocumentPreview: (filePath: string) => Promise<DocumentPreviewResult>;
}
