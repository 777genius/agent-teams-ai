import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { createMarkdownComponents } from '@renderer/components/chat/markdownComponents';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { announcementHeadingIds, announcementUrl } from './markdownPolicy';

const PublishedImage = ({ src, alt }: { src: string; alt?: string }): React.JSX.Element => {
  const [failed, setFailed] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const { t } = useAppTranslation('common');
  useEffect(() => {
    let active = true;
    setFailed(false);
    setDataUrl(null);
    void api.announcements
      .loadAsset(src)
      .then((value) => {
        if (!active) return;
        if (value) setDataUrl(value);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [src]);
  return failed ? (
    <span className="my-4 block rounded-lg border border-[var(--color-border)] p-5 text-center text-xs text-[var(--color-text-muted)]">
      {alt || t('announcements.imageUnavailable')}
    </span>
  ) : dataUrl ? (
    <img
      src={dataUrl}
      alt={alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="my-5 inline-block h-auto max-h-[60vh] max-w-full rounded-xl object-contain"
    />
  ) : (
    <span
      aria-label={alt ?? t('announcements.imageUnavailable')}
      className="my-5 block h-24 max-w-full animate-pulse rounded-xl bg-[var(--color-surface-raised)]"
    />
  );
};

export const AnnouncementMarkdown = ({
  markdown,
  bodyUrl,
}: {
  markdown: string;
  bodyUrl: string;
}): React.JSX.Element => {
  const container = useRef<HTMLDivElement>(null);
  const components = useMemo(
    () => ({
      ...createMarkdownComponents(null),
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const target = announcementUrl(href ?? '', bodyUrl);
        if (!target) return <span>{children}</span>;
        return (
          <button
            type="button"
            className="decoration-current/30 inline cursor-pointer appearance-none break-words border-0 bg-transparent p-0 text-left text-[var(--prose-link)] underline underline-offset-4 hover:decoration-current"
            onClick={() => {
              if (target.startsWith('#')) {
                try {
                  container.current
                    ?.querySelector(`#${CSS.escape(decodeURIComponent(target.slice(1)))}`)
                    ?.scrollIntoView({ block: 'start' });
                } catch {
                  /* Invalid fragment. */
                }
              } else void api.openExternal(target);
            }}
          >
            {children}
          </button>
        );
      },
      img: ({ src, alt }: { src?: string; alt?: string }) => {
        const target = announcementUrl(src ?? '', bodyUrl, true);
        return target ? <PublishedImage key={target} src={target} alt={alt} /> : <span>{alt}</span>;
      },
    }),
    [bodyUrl]
  );
  return (
    <div
      ref={container}
      className="min-w-0 break-words [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:whitespace-pre [&_table]:w-max [&_table]:min-w-full"
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          markdown.length <= 32_768
            ? [announcementHeadingIds, rehypeHighlight]
            : [announcementHeadingIds]
        }
        components={components}
        urlTransform={(url) => url}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
};
