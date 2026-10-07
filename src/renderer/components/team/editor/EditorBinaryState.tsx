/**
 * Router for binary file display — picks the right preview component
 * based on file type from the preview registry.
 */

import { Suspense } from 'react';

import { DocumentPreview } from '@features/document-preview/renderer';
import { getPreviewType, isPreviewable } from '@renderer/utils/previewRegistry';
import { getBasename } from '@shared/utils/platformPath';

import { EditorBinaryPlaceholder } from './EditorBinaryPlaceholder';
import { EditorImagePreview } from './EditorImagePreview';

interface EditorBinaryStateProps {
  filePath: string;
  size: number;
}

export const EditorBinaryState = ({
  filePath,
  size,
}: EditorBinaryStateProps): React.ReactElement => {
  const fileName = getBasename(filePath) || filePath;
  const previewType = getPreviewType(fileName);

  if (previewType === 'image' && isPreviewable(fileName, size)) {
    return <EditorImagePreview filePath={filePath} fileName={fileName} size={size} />;
  }

  if (previewType === 'document') {
    return <Suspense fallback={null}><DocumentPreview key={filePath} filePath={filePath} size={size}
      fallback={<EditorBinaryPlaceholder filePath={filePath} fileName={fileName} size={size} />} /></Suspense>;
  }

  return <EditorBinaryPlaceholder filePath={filePath} fileName={fileName} size={size} />;
};
