/**
 * Router for binary file display — picks the right preview component
 * based on file type from the preview registry.
 */

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

  return <EditorBinaryPlaceholder filePath={filePath} fileName={fileName} size={size} />;
};
