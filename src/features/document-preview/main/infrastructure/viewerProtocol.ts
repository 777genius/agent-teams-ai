import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isPathWithinRoot } from '@main/utils/pathValidation';
import { app, net, protocol, session } from 'electron';

const SCHEME = 'document-preview';
// This module is imported by IPC composition before app.whenReady(). No Node
// integration, preload, filesystem authority or CSP bypass is granted to frames.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function safePath(url: URL): string | null {
  if (url.hostname !== 'viewer' || url.port || url.username || url.password) return null;
  return decodedSafePath(url.pathname);
}

function decodedSafePath(pathname: string): string | null {
  try {
    const value = decodeURIComponent(pathname);
    if (value.includes('\\') || value.includes('\0') || value.split('/').includes('..'))
      return null;
    return value;
  } catch {
    return null;
  }
}

function isDevViewerPath(value: string): boolean {
  return (
    value === '/document-preview.html' ||
    value === '/documentPreviewFrame.ts' ||
    value === '/@vite/client' ||
    value === '/@react-refresh' ||
    value.startsWith('/file-viewer/') ||
    value.startsWith('/node_modules/.vite/') ||
    value.startsWith('/node_modules/.pnpm/') ||
    value.startsWith('/src/features/document-preview/') ||
    ['src/features/document-preview', 'node_modules/.vite', 'node_modules/.pnpm'].some(
      (directory) =>
        value.startsWith(
          '/@fs' + path.resolve(app.getAppPath(), directory).split(path.sep).join('/') + '/'
        )
    )
  );
}

export function registerViewerProtocol(): void {
  const handler =
    process.env.NODE_ENV === 'development'
      ? session.fromPartition('persist:dev').protocol
      : protocol;
  handler.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const pathname = safePath(url);
    if (!pathname) return new Response(null, { status: 403 });
    try {
      let response: Response;
      const devServer = process.env.ELECTRON_RENDERER_URL;
      if (devServer) {
        const base = new URL(devServer);
        if (
          base.protocol !== 'http:' ||
          !['localhost', '127.0.0.1'].includes(base.hostname) ||
          !isDevViewerPath(pathname)
        ) {
          return new Response(null, { status: 403 });
        }
        // Vite serves source modules during desktop development. The endpoint is
        // fixed by main's environment, never selected by a document/renderer.
        const target = new URL(pathname + url.search, base);
        const targetPath = decodedSafePath(target.pathname);
        if (target.origin !== base.origin || !targetPath || !isDevViewerPath(targetPath)) {
          return new Response(null, { status: 403 });
        }
        response = await net.fetch(target.href, { method: request.method, redirect: 'error' });
      } else {
        if (
          pathname !== '/document-preview.html' &&
          !pathname.startsWith('/assets/') &&
          !pathname.startsWith('/file-viewer/')
        ) {
          return new Response(null, { status: 403 });
        }
        const roots = [
          path.join(app.getAppPath(), 'out/renderer'),
          path.join(app.getAppPath(), 'dist-electron/renderer'),
        ];
        const root = await fs.realpath(
          roots.find((candidate) => existsSync(candidate)) ?? roots[0]
        );
        const asset = await fs.realpath(path.join(root, pathname));
        if (
          !isPathWithinRoot(asset, root, { preserveCase: true }) ||
          !(await fs.stat(asset)).isFile()
        ) {
          return new Response(null, { status: 403 });
        }
        response = await net.fetch(pathToFileURL(asset).href, { method: request.method });
      }
      const headers = new Headers(response.headers);
      if (devServer && pathname === '/document-preview.html') {
        // This frame has no React refresh boundaries. Remove Vite's injected
        // inline bootstrap/client rather than weakening the document CSP.
        const html = (await response.text())
          .replace(/<script type="module">import \{ injectIntoGlobalHook \}[\s\S]*?<\/script>/, '')
          .replace(/<script type="module" src="\/@vite\/client"><\/script>/, '');
        response = new Response(html, { status: response.status, headers });
        headers.delete('content-length');
      }
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      // No credentials or API headers are forwarded into the preview origin.
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

export function removeViewerProtocol(): void {
  const handler =
    process.env.NODE_ENV === 'development'
      ? session.fromPartition('persist:dev').protocol
      : protocol;
  handler.unhandle(SCHEME);
}
