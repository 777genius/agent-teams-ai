import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useTheme } from '@renderer/hooks/useTheme';

import { DOCUMENT_PREVIEW_MAX_BYTES } from '../../core/domain/documentPolicy';
import { useDocumentPreview } from '../hooks/useDocumentPreview';
import { getPreviewParentOrigin, isPreviewOrigin, PREVIEW_PROTOCOL } from '../utils/protocol';

interface Props {
  readonly filePath: string;
  readonly fallback: ReactNode;
  readonly size: number;
}

export function DocumentPreview(props: Props): React.ReactElement {
  const { t } = useAppTranslation('team');
  if (props.size > DOCUMENT_PREVIEW_MAX_BYTES)
    return (
      <div className="flex h-full flex-col" data-document-preview="limit">
        <p role="status" className="px-4 py-2 text-xs text-text-muted">
          {t('editor.documentPreview.limit', { size: DOCUMENT_PREVIEW_MAX_BYTES / 1024 / 1024 })}
        </p>
        <div className="min-h-0 flex-1">{props.fallback}</div>
      </div>
    );
  return <LoadedDocumentPreview {...props} />;
}

function LoadedDocumentPreview({ filePath, fallback }: Props): React.ReactElement {
  const { t } = useAppTranslation('team');
  const { resolvedTheme } = useTheme();
  const result = useDocumentPreview(filePath);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const requestId = useRef('');
  const [loadToken, setLoadToken] = useState('');

  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !isPreviewOrigin(event.origin)) return;
      const message = event.data as { protocol?: string; requestId?: string; kind?: string } | null;
      if (message?.protocol !== PREVIEW_PROTOCOL) return;
      // The public frame entry loads lazily. DOM load can precede its receiver.
      if (message.kind === 'initialized') {
        setFrameReady(true);
        return;
      }
      if (message.requestId !== requestId.current) return;
      if (message.kind === 'ready' || message.kind === 'error') setStatus(message.kind);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!frameReady || !result.document || !iframe.current?.contentWindow) return;
    const document = result.document;
    const token = crypto.randomUUID();
    requestId.current = token;
    setStatus('loading');
    setLoadToken(token);
    // Copy the IPC buffer so transfers never detach a shared response/cache.
    const buffer = new Uint8Array(document.bytes).buffer;
    iframe.current.contentWindow.postMessage(
      {
        protocol: PREVIEW_PROTOCOL,
        kind: 'load',
        requestId: requestId.current,
        buffer,
        fileName: document.fileName,
        theme: resolvedTheme,
      },
      'document-preview://viewer',
      [buffer]
    );
  }, [frameReady, result.document, resolvedTheme]);

  useEffect(() => {
    if (status !== 'loading') return;
    const timer = setTimeout(() => setStatus('error'), 60_000);
    return () => clearTimeout(timer);
  }, [loadToken, status]);

  if (result.error || status === 'error') {
    return (
      <div className="flex h-full flex-col" data-document-preview="error">
        <p role="status" className="px-4 py-2 text-xs text-text-muted">
          {t('editor.documentPreview.unavailable')}
        </p>
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-document-preview={status}>
      <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-text-muted">
        {t('editor.documentPreview.readOnly')}
      </p>
      {status === 'loading' && (
        <p role="status" className="absolute left-4 top-12 text-xs text-text-muted">
          {t('editor.documentPreview.loading')}
        </p>
      )}
      <iframe
        ref={iframe}
        title={t('editor.documentPreview.title')}
        src={`document-preview://viewer/document-preview.html?parentOrigin=${encodeURIComponent(getPreviewParentOrigin(window.location))}`}
        sandbox="allow-scripts allow-same-origin"
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
