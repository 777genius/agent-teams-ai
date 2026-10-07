import { lazy } from 'react';

// The isolated frame can import this public entry without loading app APIs/store.
export const DocumentPreview = lazy(() =>
  import('./ui/DocumentPreview').then((module) => ({ default: module.DocumentPreview }))
);

export async function initializeDocumentPreviewFrame(): Promise<void> {
  await import('./adapters/viewerFrame');
}
