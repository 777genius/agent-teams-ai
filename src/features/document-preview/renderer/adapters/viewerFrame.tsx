import React from 'react';
import { createRoot } from 'react-dom/client';

import officePreset from '@file-viewer/preset-office';
import FileViewer, { type FileViewerHandle, type ViewerOptions } from '@file-viewer/react';

import { isPreviewLoadMessage, PREVIEW_PROTOCOL } from '../utils/protocol';

const parentOrigin = new URL(window.location.href).searchParams.get('parentOrigin');
const root = createRoot(document.getElementById('root')!);
let requestId: string | null = null;
let activeReadiness: AbortController | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  if (
    event.source !== window.parent ||
    event.origin !== parentOrigin ||
    !isPreviewLoadMessage(event.data)
  )
    return;
  const message = event.data;
  activeReadiness?.abort();
  const readiness = new AbortController();
  activeReadiness = readiness;
  requestId = message.requestId;
  const viewerRef = React.createRef<FileViewerHandle>();
  let waitingForReadiness = false;
  // Workbook cell colors are author-defined. Flyfish's dark canvas can leave
  // black cell text unreadable, so spreadsheets retain their light paper surface.
  const spreadsheet = /\.xlsx$/i.test(message.fileName);
  const theme = spreadsheet ? 'light' : message.theme;
  document.body.classList.toggle('dark', theme === 'dark');
  const assetBase = new URL('./file-viewer/', window.location.href).href;
  const options: ViewerOptions = {
    preset: officePreset,
    rendererMode: 'replace',
    autoRenderers: false,
    theme,
    locale: 'en-US',
    styleIsolation: 'shadow',
    ai: false,
    toolbar: {
      download: false,
      print: false,
      exportHtml: false,
      theme: false,
      permissions: { download: false, print: false, 'export-html': false },
    },
    pdf: {
      assetBaseUrl: assetBase,
      workerUrl: new URL('vendor/pdf/pdf.worker.mjs', assetBase).href,
      streaming: false,
    },
    docx: {
      externalLinkPolicy: 'block',
      externalResourcePolicy: 'block',
      worker: true,
      workerUrl: new URL('vendor/docx/docx.worker.js', assetBase).href,
      workerJsZipUrl: new URL('vendor/docx/jszip.min.js', assetBase).href,
    },
    spreadsheet: {
      worker: true,
      workerUrl: new URL('vendor/xlsx/sheet.worker.js', assetBase).href,
    },
    presentation: { workerUrl: new URL('vendor/pptx/pptx.worker.js', assetBase).href },
  };
  const finish = (kind: 'ready' | 'error'): void => {
    if (requestId !== message.requestId || readiness.signal.aborted) return;
    window.parent.postMessage(
      { protocol: PREVIEW_PROTOCOL, requestId: message.requestId, kind },
      parentOrigin === 'null' ? '*' : parentOrigin
    );
  };
  root.render(
    <FileViewer
      ref={viewerRef}
      key={message.requestId}
      buffer={message.buffer}
      filename={message.fileName}
      options={options}
      onStateChange={(state) => {
        if (state.error) {
          finish('error');
          return;
        }
        if (!state.ready || waitingForReadiness) return;
        waitingForReadiness = true;
        void (async () => {
          // Core load-complete means the renderer shell exists. The official
          // thumbnail preparation hook also waits for PDF/Excel parsing and
          // surfaces their asynchronous parser failures, without inspecting DOM.
          const api = viewerRef.current?.getApi();
          const adapter = api && 'getThumbnailAdapter' in api ? api.getThumbnailAdapter?.() : null;
          if (/\.(pdf|xlsx)$/i.test(message.fileName) && !adapter?.beforeCapture) {
            throw new Error('Document readiness hook unavailable');
          }
          await adapter?.beforeCapture?.({
            width: 1,
            height: 1,
            format: 'png',
            quality: 1,
            fit: 'contain',
            background: 'transparent',
            signal: readiness.signal,
          });
          if (spreadsheet && api) await api.resetZoom();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
          finish('ready');
        })().catch(() => finish('error'));
      }}
    />
  );
});

// Links inside documents may neither navigate the frame nor spawn an external window.
// Capture uses composedPath because Flyfish renders inside Shadow DOM.
document.addEventListener(
  'click',
  (event) => {
    if (event.composedPath().some((node) => node instanceof HTMLAnchorElement))
      event.preventDefault();
  },
  true
);
window.addEventListener('pagehide', () => {
  requestId = null;
  activeReadiness?.abort();
  root.unmount();
});

// Explicit handshake avoids sending document bytes before a lazy module installs
// its listener. DOM load alone does not describe application receiver readiness.
window.parent.postMessage(
  { protocol: PREVIEW_PROTOCOL, kind: 'initialized' },
  parentOrigin === 'null' ? '*' : parentOrigin!
);
