import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { createMarkdownComponents } from '@renderer/components/chat/markdownComponents';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { AnnouncementAssetLoader } from './AnnouncementAssetLoader';
import { announcementHeadingIds, announcementUrl } from './markdownPolicy';

const PublishedImage = ({
  src,
  alt,
  loader,
  hero = false,
}: {
  src: string;
  alt?: string;
  loader: AnnouncementAssetLoader;
  hero?: boolean;
}): React.JSX.Element => {
  const [failed, setFailed] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const { t } = useAppTranslation('common');
  useEffect(() => {
    let active = true;
    let observer: IntersectionObserver | null = null;
    setFailed(false);
    setDataUrl(null);
    const load = (): void => {
      observer?.disconnect();
      void loader
        .load(src)
        .then((value) => {
          if (!active) return;
          if (value) setDataUrl(value);
          else setFailed(true);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    if (typeof IntersectionObserver === 'undefined' || !placeholder.current) load();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) load();
        },
        { rootMargin: '320px 0px' }
      );
      observer.observe(placeholder.current);
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [loader, src]);
  return failed ? (
    <span
      data-announcement-hero={hero ? '' : undefined}
      className={
        hero
          ? 'flex aspect-[55/12] w-full items-center justify-center bg-[var(--color-surface-raised)] p-5 text-center text-xs text-[var(--color-text-muted)]'
          : 'my-4 block rounded-lg border border-[var(--color-border)] p-5 text-center text-xs text-[var(--color-text-muted)]'
      }
    >
      {alt || t('announcements.imageUnavailable')}
    </span>
  ) : dataUrl ? (
    <img
      data-announcement-hero={hero ? '' : undefined}
      src={dataUrl}
      alt={alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={
        hero
          ? 'block aspect-[55/12] w-full object-cover'
          : 'my-5 inline-block h-auto max-h-[60vh] max-w-full rounded-xl object-contain'
      }
    />
  ) : (
    <span
      ref={placeholder}
      data-announcement-hero={hero ? '' : undefined}
      aria-label={alt ?? t('announcements.imageUnavailable')}
      className={
        hero
          ? 'block aspect-[55/12] w-full animate-pulse bg-[var(--color-surface-raised)]'
          : 'my-5 block h-24 max-w-full animate-pulse rounded-xl bg-[var(--color-surface-raised)]'
      }
    />
  );
};

export const AnnouncementMarkdown = ({
  markdown,
  bodyUrl,
  heroImagePath,
  heroImageAlt,
  notice,
}: {
  markdown: string;
  bodyUrl: string;
  heroImagePath?: string;
  heroImageAlt?: string;
  notice?: React.ReactNode;
}): React.JSX.Element => {
  const container = useRef<HTMLDivElement>(null);
  const assetLoader = useMemo(
    () => new AnnouncementAssetLoader(api.announcements, bodyUrl),
    [bodyUrl]
  );
  useEffect(() => {
    assetLoader.retain();
    return () => assetLoader.release();
  }, [assetLoader]);
  const heroImageUrl = heroImagePath ? announcementUrl(heroImagePath, bodyUrl, true) : null;
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
        return target ? (
          <PublishedImage key={target} src={target} alt={alt} loader={assetLoader} />
        ) : (
          <span>{alt}</span>
        );
      },
    }),
    [assetLoader, bodyUrl]
  );
  return (
    <>
      {heroImageUrl && (
        <PublishedImage src={heroImageUrl} alt={heroImageAlt} loader={assetLoader} hero />
      )}
      <div
        ref={container}
        className="min-w-0 break-words px-6 py-5 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:whitespace-pre [&_table]:w-max [&_table]:min-w-full"
      >
        {notice}
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
    </>
  );
};
