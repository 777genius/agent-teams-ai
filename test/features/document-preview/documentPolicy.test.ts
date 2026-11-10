import { describe, expect, it } from 'vitest';

import { getDocumentFormat } from '../../../src/features/document-preview';

describe('document format filename contract', () => {
  it('requires an extension on the final path component', () => {
    for (const name of [
      'pdf',
      'docx',
      'xlsx',
      'pptx',
      '/reports.pdf/pdf',
      'C:\\reports.docx\\docx',
      'folder.pdf/name',
    ]) {
      expect(getDocumentFormat(name), name).toBeNull();
    }
  });

  it('accepts supported case-insensitive extensions in POSIX and Windows paths', () => {
    expect(getDocumentFormat('/reports.v1/report.PDF')).toBe('pdf');
    expect(getDocumentFormat('C:\\reports.v1\\report.DOCX')).toBe('docx');
    expect(getDocumentFormat('sheet.xlsx')).toBe('xlsx');
    expect(getDocumentFormat('deck.pptx')).toBe('pptx');
  });
});
