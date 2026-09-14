import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { useAppTranslation } from '@features/localization/renderer';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { AnnouncementAssetLoader } from './AnnouncementAssetLoader';
import { announcementHeadingIds, announcementUrl } from './markdownPolicy';

import type { AnnouncementsApi } from '../contracts';
import type { Components } from 'react-markdown';

const proseBody = 'var(--prose-body)';

const announcementMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-6 text-lg font-semibold first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-5 text-base font-semibold first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-sm font-semibold first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-xs font-medium first:mt-0 text-[var(--prose-heading)]">
      {children}
    </h6>
  ),
  p: ({ children }) => (
    <p className="my-2 text-sm leading-relaxed first:mt-0 last:mb-0" style={{ color: proseBody }}>
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--prose-heading)]">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic" style={{ color: proseBody }}>
      {children}
    </em>
  ),
  del: ({ children }) => (
    <del className="line-through" style={{ color: proseBody }}>
      {children}
    </del>
  ),
  code: ({ className, children }) => {
    const content = typeof children === 'string' ? children : '';
    const block = Boolean(className?.includes('language-')) || content.includes('\n');
    return block ? (
      <code
        className={`block font-mono text-xs ${className ?? ''}`.trim()}
        style={{ color: 'var(--color-text)' }}
      >
        {children}
      </code>
    ) : (
      <code
        className="rounded px-1.5 py-0.5 font-mono text-xs"
        style={{
          backgroundColor: 'var(--prose-code-bg)',
          color: 'var(--prose-code-text)',
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      className="my-3 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed"
      style={{
        backgroundColor: 'var(--prose-pre-bg)',
        border: '1px solid var(--prose-pre-border)',
        color: 'var(--color-text)',
      }}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-4 border-[var(--prose-blockquote-border)] pl-4 italic text-[var(--prose-muted)]">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5" style={{ color: proseBody }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5" style={{ color: proseBody }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-sm" style={{ color: proseBody }}>
      {children}
    </li>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-[var(--prose-table-header-bg)]">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-[var(--prose-table-border)] px-3 py-2 text-left font-semibold text-[var(--prose-heading)]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="border border-[var(--prose-table-border)] px-3 py-2"
      style={{ color: proseBody }}
    >
      {children}
    </td>
  ),
  hr: () => <hr className="my-4 border-[var(--prose-table-border)]" />,
};

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
      aria-hidden={hero || undefined}
      className={
        hero
          ? 'flex aspect-[55/12] w-full items-center justify-center bg-[var(--color-surface-raised)] p-5 text-center text-xs text-[var(--color-text-muted)]'
          : 'my-4 block rounded-lg border border-[var(--color-border)] p-5 text-center text-xs text-[var(--color-text-muted)]'
      }
    >
      {hero ? null : alt || t('announcements.imageUnavailable')}
    </span>
  ) : dataUrl ? (
    <img
      data-announcement-hero={hero ? '' : undefined}
      src={dataUrl}
      alt={hero ? '' : (alt ?? '')}
      aria-hidden={hero || undefined}
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
      aria-label={hero ? undefined : (alt ?? t('announcements.imageUnavailable'))}
      aria-hidden={hero || undefined}
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
  notice,
  client,
  openExternal,
}: {
  markdown: string;
  bodyUrl: string;
  heroImagePath?: string;
  notice?: React.ReactNode;
  client: AnnouncementsApi;
  openExternal: (url: string) => void | Promise<unknown>;
}): React.JSX.Element => {
  const container = useRef<HTMLDivElement>(null);
  const assetLoader = useMemo(
    () => new AnnouncementAssetLoader(client, bodyUrl),
    [bodyUrl, client]
  );
  useEffect(() => {
    assetLoader.retain();
    return () => assetLoader.release();
  }, [assetLoader]);
  const heroImageUrl = heroImagePath ? announcementUrl(heroImagePath, bodyUrl, true) : null;
  const components = useMemo(
    () => ({
      ...announcementMarkdownComponents,
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const target = announcementUrl(href ?? '', bodyUrl);
        if (!target) return <span>{children}</span>;
        if (target.startsWith('#')) {
          return (
            <a
              href={target}
              className="decoration-current/30 break-words text-[var(--prose-link)] underline underline-offset-4 hover:decoration-current"
              onClick={(event) => {
                event.preventDefault();
                try {
                  container.current
                    ?.querySelector(`#${CSS.escape(decodeURIComponent(target.slice(1)))}`)
                    ?.scrollIntoView({ block: 'start' });
                } catch {
                  /* Invalid fragment. */
                }
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <span
            role="link"
            tabIndex={0}
            className="decoration-current/30 cursor-pointer break-words text-[var(--prose-link)] underline underline-offset-4 hover:decoration-current"
            onClick={() => void openExternal(target)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void openExternal(target);
            }}
          >
            {children}
          </span>
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
    [assetLoader, bodyUrl, openExternal]
  );
  return (
    <>
      {heroImageUrl && <PublishedImage src={heroImageUrl} loader={assetLoader} hero />}
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
